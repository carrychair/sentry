from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, MutableMapping, Sequence
from datetime import datetime, timedelta
from typing import Any, Final, TypedDict, cast

import sentry_sdk
from django.db import connection
from django.db.models import prefetch_related_objects
from django.db.models.aggregates import Count
from django.utils import timezone

from sentry import features, options, projectoptions, release_health, roles
from sentry.api.serializers import Serializer, register, serialize
from sentry.api.serializers.models.plugin import PluginSerializer
from sentry.api.serializers.models.team import get_org_roles
from sentry.api.serializers.types import OrganizationSerializerResponse, SerializedAvatarFields
from sentry.app import env
from sentry.auth.access import Access
from sentry.auth.superuser import is_active_superuser
from sentry.constants import ObjectStatus, StatsPeriod
from sentry.digests import backend as digests
from sentry.eventstore.models import DEFAULT_SUBJECT_TEMPLATE
from sentry.features.base import ProjectFeature
from sentry.ingest.inbound_filters import FilterTypes
from sentry.lang.native.sources import parse_sources, redact_source_secrets
from sentry.lang.native.utils import convert_crashreport_count
from sentry.models.environment import EnvironmentProject
from sentry.models.options.project_option import OPTION_KEYS, ProjectOption
from sentry.models.organizationmemberteam import OrganizationMemberTeam
from sentry.models.project import Project
from sentry.models.projectbookmark import ProjectBookmark
from sentry.models.projectplatform import ProjectPlatform
from sentry.models.projectteam import ProjectTeam
from sentry.models.release import Release
from sentry.models.user import User
from sentry.models.userreport import UserReport
from sentry.processing import realtime_metrics
from sentry.roles import organization_roles
from sentry.snuba import discover
from sentry.tasks.symbolication import should_demote_symbolication
from sentry.utils import json

STATUS_LABELS = {
    ObjectStatus.ACTIVE: "active",
    ObjectStatus.DISABLED: "deleted",
    ObjectStatus.PENDING_DELETION: "deleted",
    ObjectStatus.DELETION_IN_PROGRESS: "deleted",
}

STATS_PERIOD_CHOICES = {
    "30d": StatsPeriod(30, timedelta(hours=24)),
    "14d": StatsPeriod(14, timedelta(hours=24)),
    "7d": StatsPeriod(7, timedelta(hours=24)),
    "24h": StatsPeriod(24, timedelta(hours=1)),
    "1h": StatsPeriod(60, timedelta(minutes=1)),
}

_PROJECT_SCOPE_PREFIX = "projects:"

LATEST_DEPLOYS_KEY: Final = "latestDeploys"
UNUSED_ON_FRONTEND_FEATURES: Final = "unusedFeatures"


# These features are not used on the frontend,
# and add a lot of latency ~100-300ms per flag for large organizations
# so we exclude them from the response if the unusedFeatures collapse parameter is set
PROJECT_FEATURES_NOT_USED_ON_FRONTEND = {
    "profiling-ingest-unsampled-profiles",
    "discard-transaction",
    "span-metrics-extraction-resource",
    "span-metrics-extraction-all-modules",
    "race-free-group-creation",
    "first-event-severity-new-escalation",
    "first-event-severity-calculation",
    "first-event-severity-alerting",
    "alert-filters",
    "servicehooks",
}


def _get_team_memberships(team_list: Sequence[int], user: User) -> Iterable[OrganizationMemberTeam]:
    """Get memberships the user has in the provided team list"""
    if not user.is_authenticated:
        return []

    return list(
        OrganizationMemberTeam.objects.filter(
            organizationmember__user_id=user.id, team__in=team_list
        )
    )


def get_access_by_project(
    projects: Sequence[Project], user: User
) -> MutableMapping[Project, MutableMapping[str, Any]]:
    request = env.request

    project_teams = ProjectTeam.objects.filter(project__in=projects).values_list(
        "project_id", "team_id"
    )

    project_to_teams = defaultdict(list)
    teams_list = []
    for project_id, team_id in project_teams:
        project_to_teams[project_id].append(team_id)
        teams_list.append(team_id)

    team_memberships = _get_team_memberships(teams_list, user)

    org_ids = {i.organization_id for i in projects}
    org_roles = get_org_roles(org_ids, user)
    is_superuser = request and is_active_superuser(request) and request.user == user
    prefetch_related_objects(projects, "organization")

    result = {}
    has_team_roles_cache = {}
    with sentry_sdk.start_span(op="project.check-access"):
        for project in projects:
            parent_teams = [t for t in project_to_teams.get(project.id, [])]
            member_teams = [m for m in team_memberships if m.team_id in parent_teams]
            is_member = any(member_teams)
            org_role = org_roles.get(project.organization_id)

            has_access = bool(
                is_member
                or is_superuser
                or project.organization.flags.allow_joinleave
                or (org_role and roles.get(org_role).is_global)
            )

            team_scopes = set()

            if has_access:
                # Project can be the child of several Teams, and the User can join
                # several Teams and receive roles at each of them,
                for member in member_teams:
                    team_scopes = team_scopes.union(*[member.get_scopes(has_team_roles_cache)])

                if is_superuser:
                    org_role = organization_roles.get_top_dog().id

                if org_role:
                    minimum_team_role = roles.get_minimum_team_role(org_role)
                    team_scopes = team_scopes.union(minimum_team_role.scopes)

            result[project] = {
                "is_member": is_member,
                "has_access": has_access,
                "access": team_scopes,
            }
    return result


def get_features_for_projects(
    all_projects: Sequence[Project], user: User, filter_unused_on_frontend_features: bool = False
) -> MutableMapping[Project, list[str]]:
    # Arrange to call features.has_for_batch rather than features.has
    # for performance's sake
    projects_by_org = defaultdict(list)
    for project in all_projects:
        projects_by_org[project.organization].append(project)

    features_by_project = defaultdict(list)
    project_features = [
        feature
        for feature in features.all(feature_type=ProjectFeature).keys()
        if feature.startswith(_PROJECT_SCOPE_PREFIX)
    ]
    if filter_unused_on_frontend_features:
        project_features = [
            feature
            for feature in project_features
            if feature[len(_PROJECT_SCOPE_PREFIX) :] not in PROJECT_FEATURES_NOT_USED_ON_FRONTEND
        ]

    batch_checked = set()
    for organization, projects in projects_by_org.items():
        batch_features = features.batch_has(
            project_features, actor=user, projects=projects, organization=organization
        )

        # batch_has has found some features
        if batch_features:
            for project in projects:
                for feature_name, active in batch_features.get(f"project:{project.id}", {}).items():
                    if active:
                        features_by_project[project].append(
                            feature_name[len(_PROJECT_SCOPE_PREFIX) :]
                        )

                    batch_checked.add(feature_name)

    for feature_name in project_features:
        if feature_name in batch_checked:
            continue
        abbreviated_feature = feature_name[len(_PROJECT_SCOPE_PREFIX) :]
        for organization, projects in projects_by_org.items():
            result = features.has_for_batch(feature_name, organization, projects, user)
            for project, flag in result.items():
                if flag:
                    features_by_project[project].append(abbreviated_feature)

    for project in all_projects:
        if project.flags.has_releases:
            features_by_project[project].append("releases")

    return features_by_project


def format_options(attrs: dict[str, Any]) -> dict[str, Any]:
    options = attrs["options"]
    return {
        "sentry:csp_ignored_sources_defaults": bool(
            options.get("sentry:csp_ignored_sources_defaults", True)
        ),
        "sentry:csp_ignored_sources": "\n".join(
            options.get("sentry:csp_ignored_sources", []) or []
        ),
        "sentry:reprocessing_active": bool(options.get("sentry:reprocessing_active", False)),
        "filters:blacklisted_ips": "\n".join(options.get("sentry:blacklisted_ips", [])),
        # This option was defaulted to string but was changed at runtime to a boolean due to an error in the
        # implementation. In order to bring it back to a string, we need to repair on read stored options. This is
        # why the value true is determined by either "1" or True.
        "filters:react-hydration-errors": options.get("filters:react-hydration-errors", "1")
        in ("1", True),
        "filters:chunk-load-error": options.get("filters:chunk-load-error", "1") == "1",
        f"filters:{FilterTypes.RELEASES}": "\n".join(
            options.get(f"sentry:{FilterTypes.RELEASES}", [])
        ),
        f"filters:{FilterTypes.ERROR_MESSAGES}": "\n".join(
            options.get(f"sentry:{FilterTypes.ERROR_MESSAGES}", [])
        ),
        "feedback:branding": options.get("feedback:branding", "1") == "1",
        "sentry:feedback_user_report_notifications": bool(
            options.get("sentry:feedback_user_report_notifications")
        ),
        "sentry:feedback_ai_spam_detection": bool(options.get("sentry:feedback_ai_spam_detection")),
        "sentry:replay_rage_click_issues": options.get("sentry:replay_rage_click_issues"),
        "quotas:spike-protection-disabled": options.get("quotas:spike-protection-disabled"),
    }


class _ProjectSerializerOptionalBaseResponse(TypedDict, total=False):
    stats: Any
    transactionStats: Any
    sessionStats: Any


class ProjectSerializerBaseResponse(_ProjectSerializerOptionalBaseResponse):
    id: str
    slug: str
    name: str  # TODO: add deprecation about this field (not used in app)
    platform: str | None
    dateCreated: datetime
    isBookmarked: bool
    isMember: bool
    features: list[str]
    firstEvent: datetime | None
    firstTransactionEvent: bool
    access: list[str]
    hasAccess: bool
    hasCustomMetrics: bool
    hasMinifiedStackTrace: bool
    hasMonitors: bool
    hasProfiles: bool
    hasReplays: bool
    hasSessions: bool


class ProjectSerializerResponse(ProjectSerializerBaseResponse):
    isInternal: bool
    isPublic: bool
    avatar: SerializedAvatarFields
    color: str
    status: str  # TODO enum/literal


@register(Project)
class ProjectSerializer(Serializer):
    """
    This is primarily used to summarize projects. We utilize it when doing bulk loads for things
    such as "show all projects for this organization", and its attributes be kept to a minimum.
    """

    def __init__(
        self,
        environment_id: str | None = None,
        stats_period: str | None = None,
        expand: Iterable[str] | None = None,
        expand_context: Mapping[str, Any] | None = None,
        collapse: Iterable[str] | None = None,
        dataset: Any | None = None,
    ) -> None:
        if stats_period is not None:
            assert stats_period in STATS_PERIOD_CHOICES

        if dataset is None:
            self.dataset = discover
        else:
            self.dataset = dataset

        self.environment_id = environment_id
        self.stats_period = stats_period
        self.expand = expand
        self.expand_context = expand_context
        self.collapse = collapse

    def _expand(self, key: str) -> bool:
        if self.expand is None:
            return False

        return key in self.expand

    def _collapse(self, key: str) -> bool:
        if self.collapse is None:
            return False
        return key in self.collapse

    def get_attrs(
        self, item_list: Sequence[Project], user: User, **kwargs: Any
    ) -> MutableMapping[Project, MutableMapping[str, Any]]:
        def measure_span(op_tag):
            span = sentry_sdk.start_span(op=f"serialize.get_attrs.project.{op_tag}")
            span.set_data("Object Count", len(item_list))
            return span

        with measure_span("preamble"):
            project_ids = [i.id for i in item_list]
            if user.is_authenticated and item_list:
                bookmarks = set(
                    ProjectBookmark.objects.filter(
                        user_id=user.id, project_id__in=project_ids
                    ).values_list("project_id", flat=True)
                )
            else:
                bookmarks = set()

        with measure_span("stats"):
            stats = None
            transaction_stats = None
            session_stats = None
            project_ids = [o.id for o in item_list]

            if self.stats_period:
                stats = self.get_stats(project_ids, "!event.type:transaction")
                if self._expand("transaction_stats"):
                    transaction_stats = self.get_stats(project_ids, "event.type:transaction")
                if self._expand("session_stats"):
                    session_stats = self.get_session_stats(project_ids)

        with measure_span("options"):
            options = None
            if self._expand("options"):
                options = self.get_options(item_list)

        project_ids = [i.id for i in item_list]
        platforms = ProjectPlatform.objects.filter(project_id__in=project_ids).values_list(
            "project_id", "platform"
        )
        platforms_by_project = defaultdict(list)
        for project_id, platform in platforms:
            platforms_by_project[project_id].append(platform)

        with measure_span("access"):
            result = get_access_by_project(item_list, user)

        with measure_span("features"):
            features_by_project = get_features_for_projects(
                item_list, user, self._collapse(UNUSED_ON_FRONTEND_FEATURES)
            )
            for project, serialized in result.items():
                serialized["features"] = features_by_project[project]

        with measure_span("other"):
            for project, serialized in result.items():
                serialized.update(
                    {
                        "is_bookmarked": project.id in bookmarks,
                        "platforms": platforms_by_project[project.id],
                    }
                )
                if stats:
                    serialized["stats"] = stats[project.id]
                if transaction_stats:
                    serialized["transactionStats"] = transaction_stats[project.id]
                if session_stats:
                    serialized["sessionStats"] = session_stats[project.id]
                if options:
                    serialized["options"] = options[project.id]
        return result

    def get_stats(self, project_ids, query):
        # we need to compute stats at 1d (1h resolution), and 14d
        segments, interval = STATS_PERIOD_CHOICES[self.stats_period]
        now = timezone.now()

        params = {
            "project_id": project_ids,
            "start": now - ((segments - 1) * interval),
            "end": now,
        }
        if self.environment_id:
            query = f"{query} environment:{self.environment_id}"

        # Generate a query result to skip the top_events.find query
        top_events = {"data": [{"project_id": p} for p in project_ids]}
        stats = self.dataset.top_events_timeseries(
            timeseries_columns=["count()"],
            selected_columns=["project_id"],
            user_query=query,
            params=params,
            orderby="project_id",
            rollup=int(interval.total_seconds()),
            limit=10000,
            organization=None,
            referrer="api.serializer.projects.get_stats",
            top_events=top_events,
        )
        results = {}
        for project_id in project_ids:
            serialized = []
            str_id = str(project_id)
            if str_id in stats:
                for item in stats[str_id].data["data"]:
                    serialized.append((item["time"], item.get("count", 0)))
            results[project_id] = serialized
        return results

    def get_session_stats(self, project_ids):
        segments, interval = STATS_PERIOD_CHOICES[self.stats_period]

        now = timezone.now()
        current_interval_start = now - (segments * interval)
        previous_interval_start = now - (2 * segments * interval)

        project_health_data_dict = release_health.backend.get_current_and_previous_crash_free_rates(
            project_ids=project_ids,
            current_start=current_interval_start,
            current_end=now,
            previous_start=previous_interval_start,
            previous_end=current_interval_start,
            rollup=int(interval.total_seconds()),
        )

        # list that contains ids of projects that has both `currentCrashFreeRate` and
        # `previousCrashFreeRate` set to None and so we are not sure if they have health data or
        # not and so we add those ids to this list to check later
        check_has_health_data_ids = []

        for project_id in project_ids:
            current_crash_free_rate = project_health_data_dict[project_id]["currentCrashFreeRate"]
            previous_crash_free_rate = project_health_data_dict[project_id]["previousCrashFreeRate"]

            if [current_crash_free_rate, previous_crash_free_rate] != [None, None]:
                project_health_data_dict[project_id]["hasHealthData"] = True
            else:
                project_health_data_dict[project_id]["hasHealthData"] = False
                check_has_health_data_ids.append(project_id)

        # For project ids we are not sure if they have health data in the last 90 days we
        # call -> check_has_data with those ids and then update our `project_health_data_dict`
        # accordingly
        if check_has_health_data_ids:
            projects_with_health_data = release_health.backend.check_has_health_data(
                check_has_health_data_ids
            )
            for project_id in projects_with_health_data:
                project_health_data_dict[project_id]["hasHealthData"] = True

        return project_health_data_dict

    def get_options(self, projects):
        # no options specified
        option_list = []

        # must be a safe key
        if self.expand_context.get("options"):
            option_list = self.expand_context.get("options")
            option_list = [option for option in option_list if option in OPTION_KEYS]

        queryset = ProjectOption.objects.filter(project__in=projects, key__in=option_list)

        options_by_project = defaultdict(dict)
        for option in queryset:
            options_by_project[option.project_id][option.key] = option.value

        return options_by_project

    def serialize(
        self, obj: Project, attrs: Mapping[str, Any], user: User
    ) -> ProjectSerializerResponse:
        status_label = STATUS_LABELS.get(obj.status, "unknown")

        context: ProjectSerializerResponse = {
            "id": str(obj.id),
            "slug": obj.slug,
            "name": obj.name,  # Deprecated
            "platform": obj.platform,
            "dateCreated": obj.date_added,
            "isBookmarked": attrs["is_bookmarked"],
            "isMember": attrs["is_member"],
            "features": attrs["features"],
            "firstEvent": obj.first_event,
            "firstTransactionEvent": bool(obj.flags.has_transactions),
            "access": attrs["access"],
            "hasAccess": attrs["has_access"],
            "hasCustomMetrics": bool(obj.flags.has_custom_metrics),
            "hasMinifiedStackTrace": bool(obj.flags.has_minified_stack_trace),
            "hasMonitors": bool(obj.flags.has_cron_monitors),
            "hasProfiles": bool(obj.flags.has_profiles),
            "hasReplays": bool(obj.flags.has_replays),
            "hasFeedbacks": bool(obj.flags.has_feedbacks),
            "hasNewFeedbacks": bool(obj.flags.has_new_feedbacks),
            "hasSessions": bool(obj.flags.has_sessions),
            "isInternal": obj.is_internal_project(),
            "isPublic": obj.public,
            # Projects don't have avatar uploads, but we need to maintain the payload shape for
            # compatibility.
            "avatar": {"avatarType": "letter_avatar", "avatarUuid": None},
            "color": obj.color,
            "status": status_label,
        }
        if "stats" in attrs:
            context["stats"] = attrs["stats"]
        if "transactionStats" in attrs:
            context["transactionStats"] = attrs["transactionStats"]
        if "sessionStats" in attrs:
            context["sessionStats"] = attrs["sessionStats"]
        return context


class ProjectWithOrganizationSerializer(ProjectSerializer):
    def get_attrs(
        self, item_list: Sequence[Project], user: User, **kwargs: Any
    ) -> MutableMapping[Project, MutableMapping[str, Any]]:
        attrs = super().get_attrs(item_list, user)

        orgs = {d["id"]: d for d in serialize(list({i.organization for i in item_list}), user)}
        for item in item_list:
            attrs[item]["organization"] = orgs[str(item.organization_id)]
        return attrs

    def serialize(self, obj, attrs, user):
        data = super().serialize(obj, attrs, user)
        data["organization"] = attrs["organization"]
        return data


class TeamResponseDict(TypedDict):
    id: str
    name: str
    slug: str


class ProjectWithTeamResponseDict(ProjectSerializerResponse):
    team: TeamResponseDict
    teams: list[TeamResponseDict]


class ProjectWithTeamSerializer(ProjectSerializer):
    def get_attrs(
        self, item_list: Sequence[Project], user: User, **kwargs: Any
    ) -> MutableMapping[Project, MutableMapping[str, Any]]:
        attrs = super().get_attrs(item_list, user)

        project_teams = list(
            ProjectTeam.objects.filter(project__in=item_list).select_related("team")
        )

        teams = {
            pt.team_id: {
                "id": str(pt.team.id),
                "slug": pt.team.slug,
                "name": pt.team.name,
            }
            for pt in project_teams
        }

        teams_by_project_id = defaultdict(list)
        for pt in project_teams:
            teams_by_project_id[pt.project_id].append(teams[pt.team_id])

        for item in item_list:
            attrs[item]["teams"] = teams_by_project_id[item.id]
        return attrs

    def serialize(self, obj, attrs, user) -> ProjectWithTeamResponseDict:
        data = cast(ProjectWithTeamResponseDict, super().serialize(obj, attrs, user))
        # TODO(jess): remove this when this is deprecated
        try:
            data["team"] = attrs["teams"][0]
        except IndexError:
            pass
        data["teams"] = attrs["teams"]
        return data


class EventProcessingDict(TypedDict):
    symbolicationDegraded: bool


class LatestReleaseDict(TypedDict):
    version: str


class _OrganizationProjectOptionalResponse(TypedDict, total=False):
    latestDeploys: dict[str, dict[str, str]] | None


class OrganizationProjectResponse(
    _OrganizationProjectOptionalResponse, ProjectSerializerBaseResponse
):
    team: TeamResponseDict | None
    teams: list[TeamResponseDict]
    eventProcessing: EventProcessingDict
    platforms: list[str]
    hasUserReports: bool
    environments: list[str]
    latestRelease: LatestReleaseDict | None


class ProjectSummarySerializer(ProjectWithTeamSerializer):
    def __init__(self, access: Access | None = None, **kwargs):
        self.access = access
        super().__init__(**kwargs)

    def get_deploys_by_project(self, item_list):
        cursor = connection.cursor()
        cursor.execute(
            """
            select srpe.project_id, se.name, sr.version, date_finished
            from (
                select *
                -- Finally, filter to the top row for each project/environment.
                from (
                    -- Next we join to deploys and rank based recency of latest deploy for each project/environment.
                    select srpe.project_id, srpe.release_id, srpe.environment_id, sd.date_finished,
                    row_number() OVER (partition by (srpe.project_id, srpe.environment_id) order by sd.date_finished desc) row_num
                    from
                    (
                        -- First we fetch all related ReleaseProjectEnvironments, then filter to the x most recent for
                        -- each project/environment that actually have a deploy. This cuts out a lot of data volume
                        select *
                        from (
                            select *, row_number() OVER (partition by (srpe.project_id, srpe.environment_id) order by srpe.id desc) row_num
                            from sentry_releaseprojectenvironment srpe
                            where srpe.last_deploy_id is not null
                            and project_id = ANY(%s)
                        ) srpe
                        where row_num <= %s
                    ) srpe
                    inner join sentry_deploy sd on sd.id = srpe.last_deploy_id
                    where sd.date_finished is not null
                ) srpe
                where row_num = 1
            ) srpe
            inner join sentry_release sr on sr.id = srpe.release_id
            inner join sentry_environment se on se.id = srpe.environment_id;
            """,
            ([p.id for p in item_list], 10),
        )
        deploys_by_project = defaultdict(dict)

        for project_id, env_name, release_version, date_finished in cursor.fetchall():
            deploys_by_project[project_id][env_name] = {
                "version": release_version,
                "dateFinished": date_finished,
            }

        return deploys_by_project

    def get_attrs(
        self, item_list: Sequence[Project], user: User, **kwargs: Any
    ) -> MutableMapping[Project, MutableMapping[str, Any]]:
        attrs = super().get_attrs(item_list, user)

        projects_with_user_reports = set(
            UserReport.objects.filter(project_id__in=[item.id for item in item_list]).values_list(
                "project_id", flat=True
            )
        )

        project_envs = (
            EnvironmentProject.objects.filter(
                project_id__in=[i.id for i in item_list],
                # Including the organization_id is necessary for postgres to use indexes
                # efficiently.
                environment__organization_id=item_list[0].organization_id,
            )
            .exclude(
                is_hidden=True,
                # HACK(lb): avoiding the no environment value
            )
            .exclude(environment__name="")
            .values("project_id", "environment__name")
        )

        environments_by_project = defaultdict(list)
        for project_env in project_envs:
            environments_by_project[project_env["project_id"]].append(
                project_env["environment__name"]
            )

        # Only fetch the latest release version key for each project to cut down on response size
        latest_release_versions = _get_project_to_release_version_mapping(item_list)

        deploys_by_project = None
        if not self._collapse(LATEST_DEPLOYS_KEY):
            deploys_by_project = self.get_deploys_by_project(item_list)

        with sentry_sdk.start_span(op="project_summary_serializer.get_lpq_projects"):
            lpq_projects = realtime_metrics.get_lpq_projects()
        for item in item_list:
            attrs[item]["latest_release"] = latest_release_versions.get(item.id)
            attrs[item]["environments"] = environments_by_project.get(item.id, [])
            attrs[item]["has_user_reports"] = item.id in projects_with_user_reports
            if not self._collapse(LATEST_DEPLOYS_KEY):
                attrs[item]["deploys"] = deploys_by_project.get(item.id)
            attrs[item]["symbolication_degraded"] = should_demote_symbolication(
                project_id=item.id, lpq_projects=lpq_projects, emit_metrics=False
            )

        return attrs

    def serialize(
        self, obj: Project, attrs: Mapping[str, Any], user: User
    ) -> OrganizationProjectResponse:
        context = OrganizationProjectResponse(
            team=attrs["teams"][0] if attrs["teams"] else None,
            teams=attrs["teams"],
            id=str(obj.id),
            name=obj.name,
            slug=obj.slug,
            isBookmarked=attrs["is_bookmarked"],
            isMember=attrs["is_member"],
            access=attrs["access"],
            hasAccess=attrs["has_access"],
            dateCreated=obj.date_added,
            environments=attrs["environments"],
            eventProcessing={
                "symbolicationDegraded": attrs["symbolication_degraded"],
            },
            features=attrs["features"],
            firstEvent=obj.first_event,
            firstTransactionEvent=bool(obj.flags.has_transactions),
            hasSessions=bool(obj.flags.has_sessions),
            hasProfiles=bool(obj.flags.has_profiles),
            hasReplays=bool(obj.flags.has_replays),
            hasFeedbacks=bool(obj.flags.has_feedbacks),
            hasNewFeedbacks=bool(obj.flags.has_new_feedbacks),
            hasCustomMetrics=bool(obj.flags.has_custom_metrics),
            hasMonitors=bool(obj.flags.has_cron_monitors),
            hasMinifiedStackTrace=bool(obj.flags.has_minified_stack_trace),
            platform=obj.platform,
            platforms=attrs["platforms"],
            latestRelease=attrs["latest_release"],
            hasUserReports=attrs["has_user_reports"],
        )
        if not self._collapse(LATEST_DEPLOYS_KEY):
            context[LATEST_DEPLOYS_KEY] = attrs["deploys"]
        if "stats" in attrs:
            context.update(stats=attrs["stats"])
        if "transactionStats" in attrs:
            context.update(transactionStats=attrs["transactionStats"])
        if "sessionStats" in attrs:
            context.update(sessionStats=attrs["sessionStats"])
        if "options" in attrs:
            context.update(options=attrs["options"])

        return context


def bulk_fetch_project_latest_releases(projects: Sequence[Project]):
    """
    Fetches the latest release for each of the passed projects
    :param projects:
    :return: List of Releases, each with an additional `actual_project_id`
    attribute representing the project that they're the latest release for. If
    no release found, no entry will be returned for the given project.
    """
    # XXX: This query could be very inefficient for projects with a large
    # number of releases. To work around this, we only check 20 releases
    # ordered by highest release id, which is generally correlated with
    # most recent releases for a project. This could potentially result in
    # not having the correct most recent release, but in practice will
    # likely work fine.
    release_project_join_sql = """
        JOIN (
            SELECT *
            FROM sentry_release_project lrp
            WHERE lrp.project_id = p.id
            ORDER BY lrp.release_id DESC
            LIMIT 20
        ) lrp ON lrp.release_id = lrr.id
    """

    return list(
        Release.objects.raw(
            f"""
        SELECT lr.project_id as actual_project_id, r.*
        FROM (
            SELECT (
                SELECT lrr.id
                FROM sentry_release lrr
                {release_project_join_sql}
                WHERE lrp.project_id = p.id
                ORDER BY COALESCE(lrr.date_released, lrr.date_added) DESC
                LIMIT 1
            ) as release_id,
            p.id as project_id
            FROM sentry_project p
            WHERE p.id IN %s
        ) as lr
        JOIN sentry_release r
        ON r.id = lr.release_id
            """,
            # formatting tuples works specifically in psycopg2
            (tuple(str(i.id) for i in projects),),
        )
    )


def _get_project_to_release_version_mapping(
    item_list: Sequence[Project],
) -> dict[str, dict[str, str]]:
    """
    Return mapping of project_ID -> release version for the latest release in each project
    """
    return {
        release.actual_project_id: {"version": release.version}
        for release in bulk_fetch_project_latest_releases(item_list)
    }


class Plugin(TypedDict):
    id: str
    name: str
    slug: str
    shortName: str
    type: str
    canDisable: bool
    isTestable: bool
    hasConfiguration: bool
    metadata: dict
    contexts: list[str]
    status: str
    assets: list
    doc: str
    firstPartyAlternative: Any
    deprecationDate: Any
    altIsSentryApp: Any
    enabled: bool
    version: str
    author: dict[str, str]
    isDeprecated: bool
    isHidden: bool
    description: str
    features: list[str]
    featureDescriptions: list[dict[str, str]]
    resourceLinks: list[dict[str, str]]


class DetailedProjectResponse(ProjectWithTeamResponseDict):
    latestRelease: LatestReleaseDict | None
    options: dict[str, Any]
    digestsMinDelay: int
    digestsMaxDelay: int
    subjectPrefix: str
    allowedDomains: list[str]
    resolveAge: int
    dataScrubber: bool
    dataScrubberDefaults: bool
    safeFields: list[str]
    storeCrashReports: int | None
    sensitiveFields: list[str]
    subjectTemplate: str
    securityToken: str
    securityTokenHeader: str | None
    verifySSL: bool
    scrubIPAddresses: bool
    scrapeJavaScript: bool
    groupingConfig: str
    groupingEnhancements: str
    groupingEnhancementsBase: str | None
    secondaryGroupingExpiry: int
    secondaryGroupingConfig: str | None
    groupingAutoUpdate: bool
    fingerprintingRules: str
    organization: OrganizationSerializerResponse
    plugins: list[Plugin]
    platforms: list[str]
    processingIssues: int
    defaultEnvironment: str | None
    relayPiiConfig: str | None
    builtinSymbolSources: list[str]
    dynamicSamplingBiases: list[dict[str, str | bool]]
    eventProcessing: dict[str, bool]
    symbolSources: str


class DetailedProjectSerializer(ProjectWithTeamSerializer):
    def get_attrs(
        self, item_list: Sequence[Project], user: User, **kwargs: Any
    ) -> MutableMapping[Project, MutableMapping[str, Any]]:
        attrs = super().get_attrs(item_list, user)

        project_ids = [i.id for i in item_list]

        num_issues_projects = (
            Project.objects.filter(id__in=project_ids)
            .annotate(num_issues=Count("processingissue"))
            .values_list("id", "num_issues")
        )

        processing_issues_by_project = {}
        for project_id, num_issues in num_issues_projects:
            processing_issues_by_project[project_id] = num_issues

        queryset = ProjectOption.objects.filter(project__in=item_list, key__in=OPTION_KEYS)
        options_by_project = defaultdict(dict)
        for option in queryset.iterator():
            options_by_project[option.project_id][option.key] = option.value

        orgs = {d["id"]: d for d in serialize(list({i.organization for i in item_list}), user)}

        # Only fetch the latest release version key for each project to cut down on response size
        latest_release_versions = _get_project_to_release_version_mapping(item_list)

        for item in item_list:
            attrs[item].update(
                {
                    "latest_release": latest_release_versions.get(item.id),
                    "org": orgs[str(item.organization_id)],
                    "options": options_by_project[item.id],
                    "processing_issues": processing_issues_by_project.get(item.id, 0),
                }
            )
        return attrs

    def serialize(
        self, obj: Project, attrs: Mapping[str, Any], user: User
    ) -> DetailedProjectResponse:
        from sentry.plugins.base import plugins

        def get_value_with_default(key):
            value = attrs["options"].get(key)
            if value is not None:
                return value
            return projectoptions.get_well_known_default(
                key, epoch=attrs["options"].get("sentry:option-epoch")
            )

        data = super().serialize(obj, attrs, user)
        data.update(
            {
                "latestRelease": attrs["latest_release"],
                "options": format_options(attrs),
                "digestsMinDelay": attrs["options"].get(
                    "digests:mail:minimum_delay", digests.minimum_delay
                ),
                "digestsMaxDelay": attrs["options"].get(
                    "digests:mail:maximum_delay", digests.maximum_delay
                ),
                "subjectPrefix": attrs["options"].get(
                    "mail:subject_prefix", options.get("mail.subject-prefix")
                ),
                "allowedDomains": attrs["options"].get("sentry:origins", ["*"]),
                "resolveAge": int(attrs["options"].get("sentry:resolve_age", 0)),
                "dataScrubber": bool(attrs["options"].get("sentry:scrub_data", True)),
                "dataScrubberDefaults": bool(attrs["options"].get("sentry:scrub_defaults", True)),
                "safeFields": attrs["options"].get("sentry:safe_fields", []),
                "recapServerUrl": attrs["options"].get("sentry:recap_server_url"),
                "storeCrashReports": convert_crashreport_count(
                    attrs["options"].get("sentry:store_crash_reports"), allow_none=True
                ),
                "sensitiveFields": attrs["options"].get("sentry:sensitive_fields", []),
                "subjectTemplate": attrs["options"].get("mail:subject_template")
                or DEFAULT_SUBJECT_TEMPLATE.template,
                "securityToken": attrs["options"].get("sentry:token") or obj.get_security_token(),
                "securityTokenHeader": attrs["options"].get("sentry:token_header"),
                "verifySSL": bool(attrs["options"].get("sentry:verify_ssl", False)),
                "scrubIPAddresses": bool(attrs["options"].get("sentry:scrub_ip_address", False)),
                "scrapeJavaScript": bool(attrs["options"].get("sentry:scrape_javascript", True)),
                "groupingConfig": get_value_with_default("sentry:grouping_config"),
                "groupingEnhancements": get_value_with_default("sentry:grouping_enhancements"),
                "groupingEnhancementsBase": get_value_with_default(
                    "sentry:grouping_enhancements_base"
                ),
                "secondaryGroupingExpiry": get_value_with_default(
                    "sentry:secondary_grouping_expiry"
                ),
                "secondaryGroupingConfig": get_value_with_default(
                    "sentry:secondary_grouping_config"
                ),
                "groupingAutoUpdate": get_value_with_default("sentry:grouping_auto_update"),
                "fingerprintingRules": get_value_with_default("sentry:fingerprinting_rules"),
                "organization": attrs["org"],
                "plugins": serialize(
                    [
                        plugin
                        for plugin in plugins.configurable_for_project(obj, version=None)
                        if plugin.has_project_conf()
                    ],
                    user,
                    PluginSerializer(obj),
                ),
                "platforms": attrs["platforms"],
                "processingIssues": attrs["processing_issues"],
                "defaultEnvironment": attrs["options"].get("sentry:default_environment"),
                "relayPiiConfig": attrs["options"].get("sentry:relay_pii_config"),
                "builtinSymbolSources": get_value_with_default("sentry:builtin_symbol_sources"),
                "dynamicSamplingBiases": get_value_with_default("sentry:dynamic_sampling_biases"),
                "eventProcessing": {
                    "symbolicationDegraded": False,
                },
            }
        )
        custom_symbol_sources_json = attrs["options"].get("sentry:symbol_sources")
        try:
            sources = parse_sources(custom_symbol_sources_json, False)
        except Exception:
            # In theory sources stored on the project should be valid. If they are invalid, we don't
            # want to abort serialization just for sources, so just return an empty list instead of
            # returning sources with their secrets included.
            serialized_sources = "[]"
        else:
            redacted_sources = redact_source_secrets(sources)
            serialized_sources = json.dumps(redacted_sources)

        data.update(
            {
                "symbolSources": serialized_sources,
            }
        )

        return data

    def get_audit_log_data(self):
        return {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "status": self.status,
            "public": self.public,
        }


class SharedProjectSerializer(Serializer):
    def serialize(self, obj, attrs, user):
        from sentry import features

        feature_list = []
        for feature in ():
            if features.has("projects:" + feature, obj, actor=user):
                feature_list.append(feature)

        return {
            "slug": obj.slug,
            "name": obj.name,
            "color": obj.color,
            "features": feature_list,
            "organization": {"slug": obj.organization.slug, "name": obj.organization.name},
        }

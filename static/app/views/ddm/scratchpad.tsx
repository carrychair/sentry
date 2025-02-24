import {useCallback, useLayoutEffect, useMemo} from 'react';
import styled from '@emotion/styled';
import * as echarts from 'echarts/core';

import type {Field} from 'sentry/components/ddm/metricSamplesTable';
import {space} from 'sentry/styles/space';
import {getMetricsCorrelationSpanUrl, unescapeMetricsFormula} from 'sentry/utils/metrics';
import {MetricQueryType, type MetricWidgetQueryParams} from 'sentry/utils/metrics/types';
import type {MetricsQueryApiQueryParams} from 'sentry/utils/metrics/useMetricsQuery';
import type {MetricsSamplesResults} from 'sentry/utils/metrics/useMetricsSamples';
import useOrganization from 'sentry/utils/useOrganization';
import usePageFilters from 'sentry/utils/usePageFilters';
import useProjects from 'sentry/utils/useProjects';
import useRouter from 'sentry/utils/useRouter';
import {DDM_CHART_GROUP, MIN_WIDGET_WIDTH} from 'sentry/views/ddm/constants';
import {useDDMContext} from 'sentry/views/ddm/context';
import {parseFormula} from 'sentry/views/ddm/formulaParser/parser';
import {type TokenList, TokenType} from 'sentry/views/ddm/formulaParser/types';
import {getQuerySymbol} from 'sentry/views/ddm/querySymbol';
import {useGetCachedChartPalette} from 'sentry/views/ddm/utils/metricsChartPalette';

import type {Sample} from './widget';
import {MetricWidget} from './widget';

interface WidgetDependencies {
  dependencies: MetricsQueryApiQueryParams[];
  isError: boolean;
}

function widgetToQuery(
  widget: MetricWidgetQueryParams,
  isQueryOnly = false
): MetricsQueryApiQueryParams {
  return widget.type === MetricQueryType.FORMULA
    ? {
        name: getQuerySymbol(widget.id),
        formula: widget.formula,
      }
    : {
        name: getQuerySymbol(widget.id),
        mri: widget.mri,
        op: widget.op,
        groupBy: widget.groupBy,
        query: widget.query,
        isQueryOnly: isQueryOnly || widget.isHidden,
      };
}

export function MetricScratchpad() {
  const {
    setSelectedWidgetIndex,
    selectedWidgetIndex,
    widgets,
    updateWidget,
    showQuerySymbols,
    highlightedSampleId,
    focusArea,
    isMultiChartMode,
    metricsSamples,
  } = useDDMContext();
  const {selection} = usePageFilters();

  const router = useRouter();
  const organization = useOrganization();
  const {projects} = useProjects();
  const getChartPalette = useGetCachedChartPalette();

  // Make sure all charts are connected to the same group whenever the widgets definition changes
  useLayoutEffect(() => {
    echarts.connect(DDM_CHART_GROUP);
  }, [widgets]);

  const handleChange = useCallback(
    (index: number, widget: Partial<MetricWidgetQueryParams>) => {
      updateWidget(index, widget);
    },
    [updateWidget]
  );

  const handleSampleClick = useCallback(
    (sample: Sample) => {
      const project = projects.find(p => parseInt(p.id, 10) === sample.projectId);
      router.push(
        getMetricsCorrelationSpanUrl(
          organization,
          project?.slug,
          sample.spanId,
          sample.transactionId,
          sample.transactionSpanId
        )
      );
    },
    [projects, router, organization]
  );

  const handleSampleClickV2 = useCallback(
    (sample: MetricsSamplesResults<Field>['data'][number]) => {
      router.push(
        getMetricsCorrelationSpanUrl(
          organization,
          sample.project,
          sample.id,
          sample['transaction.id'],
          sample['segment.id']
        )
      );
    },
    [router, organization]
  );

  const firstWidget = widgets[0];

  const Wrapper =
    !isMultiChartMode || widgets.length === 1
      ? StyledSingleWidgetWrapper
      : StyledMetricDashboard;

  const queriesLookup = useMemo(() => {
    const lookup = new Map<string, MetricWidgetQueryParams>();
    widgets.forEach(widget => {
      lookup.set(getQuerySymbol(widget.id), widget);
    });
    return lookup;
  }, [widgets]);

  const getFormulaQueryDependencies = useCallback(
    (formula: string): WidgetDependencies => {
      let tokens: TokenList = [];

      try {
        tokens = parseFormula(unescapeMetricsFormula(formula));
      } catch {
        // We should not end up here, but if we do, we should not crash the UI
        return {dependencies: [], isError: true};
      }

      const dependencies: MetricsQueryApiQueryParams[] = [];
      let isError: boolean = false;

      tokens.forEach(token => {
        if (token.type === TokenType.VARIABLE) {
          const widget = queriesLookup.get(token.content);
          if (widget && widget.type === MetricQueryType.QUERY) {
            dependencies.push(widgetToQuery(widget, true));
          } else {
            isError = true;
          }
        }
      });

      return {dependencies, isError};
    },
    [queriesLookup]
  );

  const formulaDependencies = useMemo(() => {
    return widgets.reduce((acc: Record<number, WidgetDependencies>, widget) => {
      if (widget.type === MetricQueryType.FORMULA) {
        acc[widget.id] = getFormulaQueryDependencies(widget.formula);
      }
      return acc;
    }, {});
  }, [getFormulaQueryDependencies, widgets]);

  const filteredWidgets = useMemo(() => {
    return widgets.filter(
      w =>
        w.type !== MetricQueryType.FORMULA || formulaDependencies[w.id]?.isError === false
    );
  }, [formulaDependencies, widgets]);

  return (
    <Wrapper>
      {isMultiChartMode ? (
        filteredWidgets.map((widget, index) =>
          widget.isHidden ? null : (
            <MultiChartWidgetQueries
              formulaDependencies={formulaDependencies}
              widget={widget}
              key={widget.id}
            >
              {queries => (
                <MetricWidget
                  queryId={widget.id}
                  index={index}
                  getChartPalette={getChartPalette}
                  onSelect={setSelectedWidgetIndex}
                  displayType={widget.displayType}
                  focusedSeries={widget.focusedSeries}
                  tableSort={widget.sort}
                  queries={queries}
                  isSelected={selectedWidgetIndex === index}
                  hasSiblings={widgets.length > 1}
                  onChange={handleChange}
                  filters={selection}
                  focusAreaProps={focusArea}
                  showQuerySymbols={showQuerySymbols}
                  onSampleClick={handleSampleClick}
                  onSampleClickV2={handleSampleClickV2}
                  chartHeight={200}
                  highlightedSampleId={
                    selectedWidgetIndex === index ? highlightedSampleId : undefined
                  }
                  metricsSamples={metricsSamples}
                  context="ddm"
                />
              )}
            </MultiChartWidgetQueries>
          )
        )
      ) : (
        <MetricWidget
          index={0}
          getChartPalette={getChartPalette}
          onSelect={setSelectedWidgetIndex}
          displayType={firstWidget.displayType}
          focusedSeries={firstWidget.focusedSeries}
          tableSort={firstWidget.sort}
          queries={filteredWidgets
            .filter(w => !(w.type === MetricQueryType.FORMULA && w.isHidden))
            .map(w => widgetToQuery(w))}
          isSelected
          hasSiblings={false}
          onChange={handleChange}
          filters={selection}
          focusAreaProps={focusArea}
          showQuerySymbols={false}
          onSampleClick={handleSampleClick}
          onSampleClickV2={handleSampleClickV2}
          chartHeight={200}
          highlightedSampleId={highlightedSampleId}
          metricsSamples={metricsSamples}
          context="ddm"
        />
      )}
    </Wrapper>
  );
}

function MultiChartWidgetQueries({
  widget,
  formulaDependencies,
  children,
}: {
  children: (queries: MetricsQueryApiQueryParams[]) => JSX.Element;
  formulaDependencies: Record<number, WidgetDependencies>;
  widget: MetricWidgetQueryParams;
}) {
  const queries = useMemo(() => {
    return [
      widgetToQuery(widget),
      ...(widget.type === MetricQueryType.FORMULA
        ? formulaDependencies[widget.id]?.dependencies
        : []),
    ];
  }, [widget, formulaDependencies]);

  return children(queries);
}

const StyledMetricDashboard = styled('div')`
  display: grid;
  grid-template-columns: repeat(3, minmax(${MIN_WIDGET_WIDTH}px, 1fr));
  gap: ${space(2)};

  @media (max-width: ${props => props.theme.breakpoints.xxlarge}) {
    grid-template-columns: repeat(2, minmax(${MIN_WIDGET_WIDTH}px, 1fr));
  }
  @media (max-width: ${props => props.theme.breakpoints.xlarge}) {
    grid-template-columns: repeat(1, minmax(${MIN_WIDGET_WIDTH}px, 1fr));
  }
  grid-auto-rows: auto;
`;

const StyledSingleWidgetWrapper = styled('div')`
  display: grid;
  grid-template-columns: repeat(1, minmax(${MIN_WIDGET_WIDTH}px, 1fr));
`;

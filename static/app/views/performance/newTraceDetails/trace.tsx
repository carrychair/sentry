import type React from 'react';
import {Fragment, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {browserHistory} from 'react-router';
import {type Theme, useTheme} from '@emotion/react';
import styled from '@emotion/styled';
import {PlatformIcon} from 'platformicons';
import * as qs from 'query-string';

import Link from 'sentry/components/links/link';
import LoadingIndicator from 'sentry/components/loadingIndicator';
import {pickBarColor} from 'sentry/components/performance/waterfall/utils';
import Placeholder from 'sentry/components/placeholder';
import {generateIssueEventTarget} from 'sentry/components/quickTrace/utils';
import {IconFire} from 'sentry/icons';
import {t} from 'sentry/locale';
import type {Organization, PlatformKey, Project} from 'sentry/types';
import {getDuration} from 'sentry/utils/formatters';
import useApi from 'sentry/utils/useApi';
import useOnClickOutside from 'sentry/utils/useOnClickOutside';
import useOrganization from 'sentry/utils/useOrganization';
import useProjects from 'sentry/utils/useProjects';
import {
  getRovingIndexActionFromEvent,
  type RovingTabIndexAction,
  type RovingTabIndexUserActions,
} from 'sentry/views/performance/newTraceDetails/rovingTabIndex';
import type {
  TraceSearchAction,
  TraceSearchState,
} from 'sentry/views/performance/newTraceDetails/traceSearch';

import {
  isAutogroupedNode,
  isMissingInstrumentationNode,
  isParentAutogroupedNode,
  isSpanNode,
  isTraceErrorNode,
  isTraceNode,
  isTransactionNode,
} from './guards';
import {ParentAutogroupNode, type TraceTree, type TraceTreeNode} from './traceTree';
import {
  useVirtualizedList,
  type VirtualizedRow,
  type VirtualizedViewManager,
} from './virtualizedViewManager';

function Chevron(props: {direction: 'up' | 'down' | 'left'}) {
  return (
    <svg
      viewBox="0 0 16 16"
      style={{
        fill: 'currentcolor',
        color: 'currentcolor',
        transition: 'transform 120ms ease-in-out',
        transform: `rotate(${props.direction === 'up' ? 0 : props.direction === 'down' ? 180 : -90}deg)`,
      }}
    >
      <path d="M14,11.75a.74.74,0,0,1-.53-.22L8,6.06,2.53,11.53a.75.75,0,0,1-1.06-1.06l6-6a.75.75,0,0,1,1.06,0l6,6a.75.75,0,0,1,0,1.06A.74.74,0,0,1,14,11.75Z" />
    </svg>
  );
}

function decodeScrollQueue(maybePath: unknown): TraceTree.NodePath[] | null {
  if (Array.isArray(maybePath)) {
    return maybePath;
  }

  if (typeof maybePath === 'string') {
    return [maybePath as TraceTree.NodePath];
  }

  return null;
}

const COUNT_FORMATTER = Intl.NumberFormat(undefined, {notation: 'compact'});

interface RovingTabIndexState {
  index: number | null;
  items: number | null;
  node: TraceTreeNode<TraceTree.NodeValue> | null;
}

function computeNextIndexFromAction(
  current_index: number,
  action: RovingTabIndexUserActions,
  items: number
): number {
  switch (action) {
    case 'next':
      if (current_index === items) {
        return 0;
      }
      return current_index + 1;
    case 'previous':
      if (current_index === 0) {
        return items;
      }
      return current_index - 1;
    case 'last':
      return items;
    case 'first':
      return 0;
    default:
      throw new TypeError(`Invalid or not implemented reducer action - ${action}`);
  }
}

function maybeFocusRow(
  ref: HTMLDivElement | null,
  index: number,
  previouslyFocusedIndexRef: React.MutableRefObject<number | null>
) {
  if (!ref) return;
  if (index === previouslyFocusedIndexRef.current) return;

  ref.focus();
  previouslyFocusedIndexRef.current = index;
}

interface TraceProps {
  manager: VirtualizedViewManager;
  onTraceSearch: (query: string) => void;
  previousResultIndexRef: React.MutableRefObject<number | undefined>;
  roving_dispatch: React.Dispatch<RovingTabIndexAction>;
  roving_state: RovingTabIndexState;
  searchResultsIteratorIndex: number | undefined;
  searchResultsMap: Map<TraceTreeNode<TraceTree.NodeValue>, number>;
  search_dispatch: React.Dispatch<TraceSearchAction>;
  search_state: TraceSearchState;
  setDetailNode: (node: TraceTreeNode<TraceTree.NodeValue> | null) => void;
  trace: TraceTree;
  trace_id: string;
}

function Trace({
  trace,
  trace_id,
  roving_state,
  roving_dispatch,
  search_state,
  search_dispatch,
  setDetailNode,
  manager,
  searchResultsIteratorIndex,
  searchResultsMap,
  onTraceSearch,
  previousResultIndexRef,
}: TraceProps) {
  const theme = useTheme();
  const api = useApi();
  const {projects} = useProjects();
  const organization = useOrganization();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [_rerender, setRender] = useState(0);

  const previouslyFocusedIndexRef = useRef<number | null>(null);
  const treePromiseStatusRef =
    useRef<Map<TraceTreeNode<TraceTree.NodeValue>, 'loading' | 'error' | 'success'>>();

  if (!treePromiseStatusRef.current) {
    treePromiseStatusRef.current = new Map();
  }

  const scrollQueue = useRef<TraceTree.NodePath[] | null>(null);
  const treeRef = useRef<TraceTree>(trace);
  treeRef.current = trace;

  if (
    trace.root.space &&
    (trace.root.space[0] !== manager.to_origin ||
      trace.root.space[1] !== manager.trace_space.width)
  ) {
    manager.initializeTraceSpace([trace.root.space[0], 0, trace.root.space[1], 1]);
    scrollQueue.current = decodeScrollQueue(qs.parse(location.search).node);
  }

  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) {
      return;
    }
    if (trace.type === 'loading' || !manager) {
      return;
    }

    loadedRef.current = true;

    if (!scrollQueue.current) {
      if (search_state.query) {
        onTraceSearch(search_state.query);
      }
      return;
    }

    manager
      .scrollToPath(trace, scrollQueue.current, () => setRender(a => (a + 1) % 2), {
        api,
        organization,
      })
      .then(maybeNode => {
        scrollQueue.current = null;

        if (!maybeNode) {
          return;
        }

        manager.onScrollEndOutOfBoundsCheck();
        setDetailNode(maybeNode.node);
        roving_dispatch({
          type: 'set index',
          index: maybeNode.index,
          node: maybeNode.node,
        });

        if (search_state.query) {
          onTraceSearch(search_state.query);
        }
      });
  }, [
    api,
    organization,
    trace,
    trace_id,
    manager,
    search_state.query,
    onTraceSearch,
    setDetailNode,
    roving_dispatch,
  ]);

  const handleZoomIn = useCallback(
    (
      event: React.MouseEvent,
      node: TraceTreeNode<TraceTree.NodeValue>,
      value: boolean
    ) => {
      if (!isTransactionNode(node) && !isSpanNode(node)) {
        throw new TypeError('Node must be a transaction or span');
      }

      event.stopPropagation();
      setRender(a => (a + 1) % 2);

      treeRef.current
        .zoomIn(node, value, {
          api,
          organization,
        })
        .then(() => {
          setRender(a => (a + 1) % 2);
          if (search_state.query) {
            onTraceSearch(search_state.query);
          }

          if (search_state.resultsLookup.has(node)) {
            const idx = search_state.resultsLookup.get(node)!;

            search_dispatch({
              type: 'set iterator index',
              resultIndex: search_state.results?.[idx]?.index!,
              resultIteratorIndex: idx,
            });
          } else {
            search_dispatch({type: 'clear iterator index'});
          }
          treePromiseStatusRef.current!.set(node, 'success');
        })
        .catch(_e => {
          treePromiseStatusRef.current!.set(node, 'error');
        });
    },
    [api, organization, search_state, search_dispatch, onTraceSearch]
  );

  const handleExpandNode = useCallback(
    (
      event: React.MouseEvent<Element>,
      node: TraceTreeNode<TraceTree.NodeValue>,
      value: boolean
    ) => {
      event.stopPropagation();

      treeRef.current.expand(node, value);
      setRender(a => (a + 1) % 2);

      if (search_state.query) {
        onTraceSearch(search_state.query);
      }

      if (search_state.resultsLookup.has(node)) {
        const idx = search_state.resultsLookup.get(node)!;

        search_dispatch({
          type: 'set iterator index',
          resultIndex: search_state.results?.[idx]?.index!,
          resultIteratorIndex: idx,
        });
      } else {
        search_dispatch({type: 'clear iterator index'});
      }
    },
    [search_state, search_dispatch, onTraceSearch]
  );

  const onRowClick = useCallback(
    (
      _event: React.MouseEvent,
      index: number,
      node: TraceTreeNode<TraceTree.NodeValue>
    ) => {
      previousResultIndexRef.current = index;
      previouslyFocusedIndexRef.current = index;
      browserHistory.push({
        pathname: location.pathname,
        query: {
          ...qs.parse(location.search),
          node: node.path,
        },
      });
      setDetailNode(node);
      roving_dispatch({type: 'set index', index, node});

      if (search_state.resultsLookup.has(node)) {
        const idx = search_state.resultsLookup.get(node)!;

        search_dispatch({
          type: 'set iterator index',
          resultIndex: index,
          resultIteratorIndex: idx,
        });
      } else {
        search_dispatch({type: 'clear iterator index'});
      }
    },
    [
      roving_dispatch,
      setDetailNode,
      search_state,
      search_dispatch,
      previousResultIndexRef,
    ]
  );

  const onOutsideClick = useCallback(() => {
    const {node: _node, ...queryParamsWithoutNode} = qs.parse(location.search);

    browserHistory.push({
      pathname: location.pathname,
      query: queryParamsWithoutNode,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useOnClickOutside(containerRef.current, onOutsideClick);

  const onRowKeyDown = useCallback(
    (
      event: React.KeyboardEvent,
      index: number,
      node: TraceTreeNode<TraceTree.NodeValue>
    ) => {
      if (!manager.list) {
        return;
      }
      const action = getRovingIndexActionFromEvent(event);
      if (action) {
        event.preventDefault();
        const nextIndex = computeNextIndexFromAction(
          index,
          action,
          treeRef.current.list.length - 1
        );
        manager.list.scrollToRow(nextIndex);
        roving_dispatch({type: 'set index', index: nextIndex, node});

        if (search_state.resultsLookup.has(trace.list[nextIndex])) {
          const idx = search_state.resultsLookup.get(trace.list[nextIndex])!;

          search_dispatch({
            type: 'set iterator index',
            resultIndex: nextIndex,
            resultIteratorIndex: idx,
          });
        } else {
          search_dispatch({type: 'clear iterator index'});
        }
      }
    },
    [manager.list, roving_dispatch, search_state, search_dispatch, trace.list]
  );

  // @TODO this is the implementation of infinite scroll. Once the user
  // reaches the end of the list, we fetch more data. The data is not yet
  // being appended to the tree as we need to figure out UX for this.
  // onRowsRendered callback should be passed to the List component

  // const limitRef = useRef<number | null>(null);
  // if (limitRef.current === null) {
  //   let decodedLimit = getTraceQueryParams(qs.parse(location.search)).limit;
  //   if (typeof decodedLimit === 'string') {
  //     decodedLimit = parseInt(decodedLimit, 2);
  //   }

  //   limitRef.current = decodedLimit;
  // }

  // const loadMoreRequestRef =
  //   useRef<Promise<TraceSplitResults<TraceFullDetailed> | null> | null>(null);

  // const onRowsRendered = useCallback((rows: RenderedRows) => {
  //   if (loadMoreRequestRef.current) {
  //     // in flight request
  //     return;
  //   }
  //   if (rows.stopIndex !== treeRef.current.list.length - 1) {
  //     // not at the end
  //     return;
  //   }
  //   if (
  //     !loadMoreRequestRef.current &&
  //     limitRef.current &&
  //     rows.stopIndex === treeRef.current.list.length - 1
  //   ) {
  //     limitRef.current = limitRef.current + 500;
  //     const promise = fetchTrace(api, {
  //       traceId: trace_id,
  //       orgSlug: organization.slug,
  //       query: qs.stringify(getTraceQueryParams(location, {limit: limitRef.current})),
  //     })
  //       .then(data => {
  //         return data;
  //       })
  //       .catch(e => {
  //         return e;
  //       });

  //     loadMoreRequestRef.current = promise;
  //   }
  // }, []);

  const projectLookup: Record<string, PlatformKey | undefined> = useMemo(() => {
    return projects.reduce<Record<Project['slug'], Project['platform']>>(
      (acc, project) => {
        acc[project.slug] = project.platform;
        return acc;
      },
      {}
    );
  }, [projects]);

  const render = useCallback(
    (n: VirtualizedRow) => {
      return trace.type === 'loading' ? (
        <RenderPlaceholderRow
          key={n.key}
          index={n.index}
          style={n.style}
          node={n.item}
          theme={theme}
          projects={projectLookup}
          manager={manager}
        />
      ) : (
        <RenderRow
          key={n.key}
          index={n.index}
          organization={organization}
          previouslyFocusedIndexRef={previouslyFocusedIndexRef}
          tabIndex={roving_state.index ?? -1}
          isSearchResult={searchResultsMap.has(n.item)}
          searchResultsIteratorIndex={searchResultsIteratorIndex}
          style={n.style}
          trace_id={trace_id}
          projects={projectLookup}
          node={n.item}
          manager={manager}
          theme={theme}
          onExpand={handleExpandNode}
          onZoomIn={handleZoomIn}
          onRowClick={onRowClick}
          onRowKeyDown={onRowKeyDown}
        />
      );
    },
    // we add _rerender as a dependency to trigger the virtualized list rerender
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      handleExpandNode,
      handleZoomIn,
      manager,
      onRowClick,
      onRowKeyDown,
      organization,
      projectLookup,
      roving_state.index,
      searchResultsIteratorIndex,
      searchResultsMap,
      theme,
      trace_id,
      trace.type,
      _rerender,
    ]
  );

  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const virtualizedList = useVirtualizedList({
    manager,
    items: trace.list,
    container: scrollContainer,
    render,
  });

  return (
    <TraceStylingWrapper
      ref={r => {
        containerRef.current = r;
        manager.onContainerRef(r);
      }}
      className={`${trace.indicators.length > 0 ? 'WithIndicators' : ''} ${trace.type === 'loading' ? 'Loading' : ''}`}
    >
      <div className="TraceDivider" ref={r => manager?.registerDividerRef(r)} />
      {trace.type === 'loading' ? <TraceLoading /> : null}
      <div
        className="TraceIndicatorContainer"
        ref={r => manager.registerIndicatorContainerRef(r)}
      >
        {trace.indicators.length > 0
          ? trace.indicators.map((indicator, i) => {
              return (
                <div
                  key={i}
                  ref={r => manager.registerIndicatorRef(r, i, indicator)}
                  className="TraceIndicator"
                >
                  <div className="TraceIndicatorLabel">{indicator.label}</div>
                  <div className="TraceIndicatorLine" />
                </div>
              );
            })
          : null}

        {manager.interval_bars.map((_, i) => {
          const indicatorTimestamp = manager.intervals[i];
          const timestamp = manager.to_origin + indicatorTimestamp ?? 0;

          if (trace.type === 'loading') {
            return null;
          }

          return (
            <div
              key={i}
              ref={r => manager.registerTimelineIndicatorRef(r, i)}
              className="TraceIndicator Timeline"
              style={{
                transform: `translate(${manager.computeTransformXFromTimestamp(timestamp)}px, 0)`,
              }}
            >
              <div className="TraceIndicatorLabel">
                {indicatorTimestamp > 0
                  ? getDuration(
                      (manager.trace_view.x + indicatorTimestamp) / 1000,
                      2,
                      true
                    )
                  : '0s'}
              </div>
              <div className="TraceIndicatorLine" />
            </div>
          );
        })}
      </div>
      <div ref={r => setScrollContainer(r)}>
        <div>{virtualizedList.rendered}</div>
      </div>
    </TraceStylingWrapper>
  );
}

export default Trace;

function RenderRow(props: {
  index: number;
  isSearchResult: boolean;
  manager: VirtualizedViewManager;
  node: TraceTreeNode<TraceTree.NodeValue>;
  onExpand: (
    event: React.MouseEvent<Element>,
    node: TraceTreeNode<TraceTree.NodeValue>,
    value: boolean
  ) => void;
  onRowClick: (
    event: React.MouseEvent<Element>,
    index: number,
    node: TraceTreeNode<TraceTree.NodeValue>
  ) => void;
  onRowKeyDown: (
    event: React.KeyboardEvent,
    index: number,
    node: TraceTreeNode<TraceTree.NodeValue>
  ) => void;
  onZoomIn: (
    event: React.MouseEvent<Element>,
    node: TraceTreeNode<TraceTree.NodeValue>,
    value: boolean
  ) => void;
  organization: Organization;
  previouslyFocusedIndexRef: React.MutableRefObject<number | null>;
  projects: Record<Project['slug'], Project['platform']>;
  searchResultsIteratorIndex: number | undefined;
  style: React.CSSProperties;
  tabIndex: number;
  theme: Theme;
  trace_id: string;
}) {
  const virtualized_index = props.index - props.manager.start_virtualized_index;
  if (!props.node.value) {
    return null;
  }

  const rowSearchClassName = `${props.isSearchResult ? 'SearchResult' : ''} ${props.searchResultsIteratorIndex === props.index ? 'Highlight' : ''}`;

  if (isAutogroupedNode(props.node)) {
    return (
      <div
        key={props.index}
        ref={r =>
          props.tabIndex === props.index
            ? maybeFocusRow(r, props.index, props.previouslyFocusedIndexRef)
            : null
        }
        tabIndex={props.tabIndex === props.index ? 0 : -1}
        className={`Autogrouped TraceRow ${rowSearchClassName}`}
        onClick={e => props.onRowClick(e, props.index, props.node)}
        onKeyDown={event => props.onRowKeyDown(event, props.index, props.node)}
        style={{
          top: props.style.top,
          height: props.style.height,
        }}
      >
        <div
          className="TraceLeftColumn"
          ref={r =>
            props.manager.registerColumnRef('list', r, virtualized_index, props.node)
          }
          style={{
            width: props.manager.columns.list.width * 100 + '%',
          }}
        >
          <div
            className={`TraceLeftColumnInner ${props.node.has_error ? 'Errored' : ''}`}
            style={{
              paddingLeft: props.node.depth * props.manager.row_depth_padding,
            }}
          >
            <div className="TraceChildrenCountWrapper">
              <Connectors node={props.node} manager={props.manager} />
              <ChildrenButton
                icon={
                  props.node.expanded ? (
                    <Chevron direction="up" />
                  ) : (
                    <Chevron direction="down" />
                  )
                }
                status={props.node.fetchStatus}
                expanded={!props.node.expanded}
                onClick={e => props.onExpand(e, props.node, !props.node.expanded)}
                errored={props.node.has_error}
              >
                {COUNT_FORMATTER.format(props.node.groupCount)}
              </ChildrenButton>
            </div>

            <span className="TraceOperation">{t('Autogrouped')}</span>
            <strong className="TraceEmDash"> — </strong>
            <span className="TraceDescription">{props.node.value.autogrouped_by.op}</span>
          </div>
        </div>
        <div
          className={`TraceRightColumn ${props.index % 2 === 0 ? 0 : 'Odd'}`}
          ref={r =>
            props.manager.registerColumnRef('span_list', r, virtualized_index, props.node)
          }
          style={{
            width: props.manager.columns.span_list.width * 100 + '%',
          }}
          onDoubleClick={e => {
            e.stopPropagation();
            props.manager.onZoomIntoSpace(props.node.space!);
          }}
        >
          <AutogroupedTraceBar
            virtualized_index={virtualized_index}
            manager={props.manager}
            color={props.theme.blue300}
            entire_space={props.node.space}
            node_spaces={props.node.autogroupedSegments}
          />
          <button
            ref={ref =>
              props.manager.registerArrowRef(ref, props.node.space!, virtualized_index)
            }
            className="TraceArrow"
            onClick={_e => {
              props.manager.onBringRowIntoView(props.node.space!);
            }}
          >
            <Chevron direction="left" />
          </button>
        </div>
      </div>
    );
  }

  if (isTransactionNode(props.node)) {
    const errored =
      props.node.value.errors.length > 0 ||
      props.node.value.performance_issues.length > 0;
    return (
      <div
        key={props.index}
        ref={r =>
          props.tabIndex === props.index
            ? maybeFocusRow(r, props.index, props.previouslyFocusedIndexRef)
            : null
        }
        tabIndex={props.tabIndex === props.index ? 0 : -1}
        className={`TraceRow ${rowSearchClassName}`}
        onClick={e => props.onRowClick(e, props.index, props.node)}
        onKeyDown={event => props.onRowKeyDown(event, props.index, props.node)}
        style={{
          top: props.style.top,
          height: props.style.height,
        }}
      >
        <div
          className="TraceLeftColumn"
          ref={r =>
            props.manager.registerColumnRef('list', r, virtualized_index, props.node)
          }
          style={{
            width: props.manager.columns.list.width * 100 + '%',
          }}
        >
          <div
            className={`TraceLeftColumnInner ${errored ? 'Errored' : ''}`}
            style={{
              paddingLeft: props.node.depth * props.manager.row_depth_padding,
            }}
          >
            <div
              className={`TraceChildrenCountWrapper ${
                props.node.isOrphaned ? 'Orphaned' : ''
              }
              `}
            >
              <Connectors node={props.node} manager={props.manager} />
              {props.node.children.length > 0 || props.node.canFetch ? (
                <ChildrenButton
                  icon={
                    props.node.canFetch && props.node.fetchStatus === 'idle' ? (
                      '+'
                    ) : props.node.canFetch && props.node.zoomedIn ? (
                      <Chevron direction="down" />
                    ) : (
                      '+'
                    )
                  }
                  status={props.node.fetchStatus}
                  expanded={props.node.expanded || props.node.zoomedIn}
                  onClick={e =>
                    props.node.canFetch
                      ? props.onZoomIn(e, props.node, !props.node.zoomedIn)
                      : props.onExpand(e, props.node, !props.node.expanded)
                  }
                  errored={errored}
                >
                  {props.node.children.length > 0
                    ? COUNT_FORMATTER.format(props.node.children.length)
                    : null}
                </ChildrenButton>
              ) : null}
            </div>
            <PlatformIcon
              platform={props.projects[props.node.value.project_slug] ?? 'default'}
            />
            <span className="TraceOperation">{props.node.value['transaction.op']}</span>
            <strong className="TraceEmDash"> — </strong>
            <span>{props.node.value.transaction}</span>
          </div>
        </div>
        <div
          ref={r =>
            props.manager.registerColumnRef('span_list', r, virtualized_index, props.node)
          }
          className={`TraceRightColumn ${props.index % 2 === 0 ? 0 : 'Odd'}`}
          style={{
            width: props.manager.columns.span_list.width * 100 + '%',
          }}
          onDoubleClick={e => {
            e.stopPropagation();
            props.manager.onZoomIntoSpace(props.node.space!);
          }}
        >
          <TraceBar
            virtualized_index={virtualized_index}
            manager={props.manager}
            color={pickBarColor(props.node.value['transaction.op'])}
            node_space={props.node.space}
          />
          <button
            ref={ref =>
              props.manager.registerArrowRef(ref, props.node.space!, virtualized_index)
            }
            className="TraceArrow"
            onClick={_e => {
              props.manager.onBringRowIntoView(props.node.space!);
            }}
          >
            <Chevron direction="left" />
          </button>
        </div>
      </div>
    );
  }

  if (isSpanNode(props.node)) {
    const errored = props.node.value.relatedErrors.length > 0;
    return (
      <div
        key={props.index}
        ref={r =>
          props.tabIndex === props.index
            ? maybeFocusRow(r, props.index, props.previouslyFocusedIndexRef)
            : null
        }
        tabIndex={props.tabIndex === props.index ? 0 : -1}
        className={`TraceRow ${rowSearchClassName}`}
        onClick={e => props.onRowClick(e, props.index, props.node)}
        onKeyDown={event => props.onRowKeyDown(event, props.index, props.node)}
        style={{
          top: props.style.top,
          height: props.style.height,
        }}
      >
        <div
          className="TraceLeftColumn"
          ref={r =>
            props.manager.registerColumnRef('list', r, virtualized_index, props.node)
          }
          style={{
            width: props.manager.columns.list.width * 100 + '%',
          }}
        >
          <div
            className={`TraceLeftColumnInner ${errored ? 'Errored' : ''}`}
            style={{
              paddingLeft: props.node.depth * props.manager.row_depth_padding,
            }}
          >
            <div
              className={`TraceChildrenCountWrapper ${
                props.node.isOrphaned ? 'Orphaned' : ''
              }`}
            >
              <Connectors node={props.node} manager={props.manager} />
              {props.node.children.length > 0 || props.node.canFetch ? (
                <ChildrenButton
                  icon={
                    props.node.canFetch ? (
                      '+'
                    ) : props.node.expanded ? (
                      <Chevron direction="up" />
                    ) : (
                      <Chevron direction="down" />
                    )
                  }
                  status={props.node.fetchStatus}
                  expanded={props.node.expanded || props.node.zoomedIn}
                  onClick={e =>
                    props.node.canFetch
                      ? props.onZoomIn(e, props.node, !props.node.zoomedIn)
                      : props.onExpand(e, props.node, !props.node.expanded)
                  }
                  errored={errored}
                >
                  {props.node.children.length > 0
                    ? COUNT_FORMATTER.format(props.node.children.length)
                    : null}
                </ChildrenButton>
              ) : null}
            </div>
            <span className="TraceOperation">{props.node.value.op ?? '<unknown>'}</span>
            <strong className="TraceEmDash"> — </strong>
            <span className="TraceDescription" title={props.node.value.description}>
              {!props.node.value.description
                ? 'unknown'
                : props.node.value.description.length > 100
                  ? props.node.value.description.slice(0, 100).trim() + '\u2026'
                  : props.node.value.description}
            </span>
          </div>
        </div>
        <div
          ref={r =>
            props.manager.registerColumnRef('span_list', r, virtualized_index, props.node)
          }
          className={`TraceRightColumn ${props.index % 2 === 0 ? 0 : 'Odd'}`}
          style={{
            width: props.manager.columns.span_list.width * 100 + '%',
          }}
          onDoubleClick={e => {
            e.stopPropagation();
            props.manager.onZoomIntoSpace(props.node.space!);
          }}
        >
          <TraceBar
            virtualized_index={virtualized_index}
            manager={props.manager}
            color={pickBarColor(props.node.value.op)}
            node_space={props.node.space}
          />
          <button
            ref={ref =>
              props.manager.registerArrowRef(ref, props.node.space!, virtualized_index)
            }
            className="TraceArrow"
            onClick={_e => {
              props.manager.onBringRowIntoView(props.node.space!);
            }}
          >
            <Chevron direction="left" />
          </button>
        </div>
      </div>
    );
  }

  if (isMissingInstrumentationNode(props.node)) {
    return (
      <div
        key={props.index}
        ref={r =>
          props.tabIndex === props.index
            ? maybeFocusRow(r, props.index, props.previouslyFocusedIndexRef)
            : null
        }
        tabIndex={props.tabIndex === props.index ? 0 : -1}
        className={`TraceRow ${rowSearchClassName}`}
        onClick={e => props.onRowClick(e, props.index, props.node)}
        onKeyDown={event => props.onRowKeyDown(event, props.index, props.node)}
        style={{
          top: props.style.top,
          height: props.style.height,
        }}
      >
        <div
          className="TraceLeftColumn"
          ref={r =>
            props.manager.registerColumnRef('list', r, virtualized_index, props.node)
          }
          style={{
            width: props.manager.columns.list.width * 100 + '%',
          }}
        >
          <div
            className="TraceLeftColumnInner"
            style={{
              paddingLeft: props.node.depth * props.manager.row_depth_padding,
            }}
          >
            <div className="TraceChildrenCountWrapper">
              <Connectors node={props.node} manager={props.manager} />
            </div>
            <span className="TraceOperation">{t('Missing instrumentation')}</span>
          </div>
        </div>
        <div
          ref={r =>
            props.manager.registerColumnRef('span_list', r, virtualized_index, props.node)
          }
          className={`TraceRightColumn ${props.index % 2 === 0 ? 0 : 'Odd'}`}
          style={{
            width: props.manager.columns.span_list.width * 100 + '%',
          }}
          onDoubleClick={e => {
            e.stopPropagation();
            props.manager.onZoomIntoSpace(props.node.space!);
          }}
        >
          <TraceBar
            virtualized_index={virtualized_index}
            manager={props.manager}
            color={pickBarColor('missing-instrumentation')}
            node_space={props.node.space}
          />
          <button
            ref={ref =>
              props.manager.registerArrowRef(ref, props.node.space!, virtualized_index)
            }
            className="TraceArrow"
            onClick={_e => {
              props.manager.onBringRowIntoView(props.node.space!);
            }}
          >
            <Chevron direction="left" />
          </button>
        </div>
      </div>
    );
  }

  if (isTraceNode(props.node)) {
    return (
      <div
        key={props.index}
        ref={r =>
          props.tabIndex === props.index
            ? maybeFocusRow(r, props.index, props.previouslyFocusedIndexRef)
            : null
        }
        tabIndex={props.tabIndex === props.index ? 0 : -1}
        className={`TraceRow ${rowSearchClassName}`}
        onClick={e => props.onRowClick(e, props.index, props.node)}
        onKeyDown={event => props.onRowKeyDown(event, props.index, props.node)}
        style={{
          top: props.style.top,
          height: props.style.height,
        }}
      >
        <div
          className="TraceLeftColumn"
          ref={r =>
            props.manager.registerColumnRef('list', r, virtualized_index, props.node)
          }
          style={{
            width: props.manager.columns.list.width * 100 + '%',
          }}
        >
          <div
            className="TraceLeftColumnInner"
            style={{
              paddingLeft: props.node.depth * props.manager.row_depth_padding,
            }}
          >
            <div className="TraceChildrenCountWrapper Root">
              <Connectors node={props.node} manager={props.manager} />
              {props.node.children.length > 0 || props.node.canFetch ? (
                <ChildrenButton icon={''} status={'idle'} expanded onClick={() => void 0}>
                  {props.node.children.length > 0
                    ? COUNT_FORMATTER.format(props.node.children.length)
                    : null}
                </ChildrenButton>
              ) : null}
            </div>

            <span className="TraceOperation">{t('Trace')}</span>
            <strong className="TraceEmDash"> — </strong>
            <span className="TraceDescription">{props.trace_id}</span>
          </div>
        </div>
        <div
          ref={r =>
            props.manager.registerColumnRef('span_list', r, virtualized_index, props.node)
          }
          className={`TraceRightColumn ${props.index % 2 === 0 ? 0 : 'Odd'}`}
          style={{
            width: props.manager.columns.span_list.width * 100 + '%',
          }}
          onDoubleClick={e => {
            e.stopPropagation();
            props.manager.onZoomIntoSpace(props.node.space!);
          }}
        >
          <TraceBar
            virtualized_index={virtualized_index}
            manager={props.manager}
            color={pickBarColor('missing-instrumentation')}
            node_space={props.node.space}
          />
          <button
            ref={ref =>
              props.manager.registerArrowRef(ref, props.node.space!, virtualized_index)
            }
            className="TraceArrow"
            onClick={_e => {
              props.manager.onBringRowIntoView(props.node.space!);
            }}
          >
            <Chevron direction="left" />
          </button>
        </div>
      </div>
    );
  }

  if (isTraceErrorNode(props.node)) {
    return (
      <div
        key={props.index}
        ref={r =>
          props.tabIndex === props.index
            ? maybeFocusRow(r, props.index, props.previouslyFocusedIndexRef)
            : null
        }
        tabIndex={props.tabIndex === props.index ? 0 : -1}
        className={`TraceRow ${rowSearchClassName}`}
        onClick={e => props.onRowClick(e, props.index, props.node)}
        onKeyDown={event => props.onRowKeyDown(event, props.index, props.node)}
        style={{
          top: props.style.top,
          height: props.style.height,
        }}
      >
        <div
          className="TraceLeftColumn"
          ref={r =>
            props.manager.registerColumnRef('list', r, virtualized_index, props.node)
          }
          style={{
            width: props.manager.columns.list.width * 100 + '%',
          }}
        >
          <div
            className="TraceLeftColumnInner"
            style={{
              paddingLeft: props.node.depth * props.manager.row_depth_padding,
            }}
          >
            <div className="TraceChildrenCountWrapper">
              <Connectors node={props.node} manager={props.manager} />
              {props.node.children.length > 0 || props.node.canFetch ? (
                <ChildrenButton
                  icon={''}
                  status={props.node.fetchStatus}
                  expanded={props.node.expanded || props.node.zoomedIn}
                  onClick={e => props.onExpand(e, props.node, !props.node.expanded)}
                >
                  {props.node.children.length > 0
                    ? COUNT_FORMATTER.format(props.node.children.length)
                    : null}
                </ChildrenButton>
              ) : null}
            </div>
            <PlatformIcon
              platform={props.projects[props.node.value.project_slug] ?? 'default'}
            />
            ;
            <Link
              className="Errored Link"
              onClick={e => e.stopPropagation()}
              to={generateIssueEventTarget(props.node.value, props.organization)}
            >
              <span className="TraceOperation">{t('Error')}</span>
              <strong className="TraceEmDash"> — </strong>
              <span className="TraceDescription">{props.node.value.title}</span>
            </Link>
          </div>
        </div>
        <div
          ref={r =>
            props.manager.registerColumnRef('span_list', r, virtualized_index, props.node)
          }
          className={`TraceRightColumn ${props.index % 2 === 0 ? 0 : 'Odd'}`}
          style={{
            width: props.manager.columns.span_list.width * 100 + '%',
          }}
          onDoubleClick={e => {
            e.stopPropagation();
            props.manager.onZoomIntoSpace(props.node.space!);
          }}
        >
          {typeof props.node.value.timestamp === 'number' ? (
            <div
              className="ErrorIconBorder"
              style={{
                transform: `translateX(${props.manager.computeTransformXFromTimestamp(
                  props.node.value.timestamp * 1000
                )}px)`,
              }}
            >
              <IconFire color="errorText" size="xs" />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return null;
}

function RenderPlaceholderRow(props: {
  index: number;
  manager: VirtualizedViewManager;
  node: TraceTreeNode<TraceTree.NodeValue>;
  projects: Record<Project['slug'], Project['platform']>;
  style: React.CSSProperties;
  theme: Theme;
}) {
  return (
    <div
      key={props.index}
      className="TraceRow"
      style={{
        top: props.style.top,
        height: props.style.height,
        pointerEvents: 'none',
        color: props.theme.subText,
        paddingLeft: 8,
      }}
    >
      <div
        className="TraceLeftColumn"
        style={{width: props.manager.columns.list.width * 100 + '%'}}
      >
        <div
          className="TraceLeftColumnInner"
          style={{
            paddingLeft: props.node.depth * props.manager.row_depth_padding,
          }}
        >
          <div
            className={`TraceChildrenCountWrapper ${isTraceNode(props.node) ? 'Root' : ''}`}
          >
            <Connectors node={props.node} manager={props.manager} />
            {props.node.children.length > 0 || props.node.canFetch ? (
              <ChildrenButton
                icon="+"
                status={props.node.fetchStatus}
                expanded={props.node.expanded || props.node.zoomedIn}
                onClick={() => void 0}
              >
                {props.node.children.length > 0
                  ? COUNT_FORMATTER.format(props.node.children.length)
                  : null}
              </ChildrenButton>
            ) : null}
          </div>
          <Placeholder
            className="Placeholder"
            height="12px"
            width={randomBetween(20, 80) + '%'}
            style={{
              transition: 'all 30s ease-out',
            }}
          />
        </div>
      </div>
      <div
        className={`TraceRightColumn ${props.index % 2 === 0 ? 0 : 'Odd'}`}
        style={{
          width: props.manager.columns.span_list.width * 100 + '%',
          backgroundColor:
            props.index % 2 === 0 ? props.theme.backgroundSecondary : undefined,
        }}
      >
        <Placeholder
          className="Placeholder"
          height="12px"
          width={randomBetween(20, 80) + '%'}
          style={{
            transition: 'all 30s ease-out',
            transform: `translate(${randomBetween(0, 200) + 'px'}, 0)`,
          }}
        />
      </div>
    </div>
  );
}

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function Connectors(props: {
  manager: VirtualizedViewManager;
  node: TraceTreeNode<TraceTree.NodeValue>;
}) {
  const showVerticalConnector =
    ((props.node.expanded || props.node.zoomedIn) && props.node.children.length > 0) ||
    (props.node.value && isParentAutogroupedNode(props.node));

  // If the tail node of the collapsed node has no children,
  // we don't want to render the vertical connector as no children
  // are being rendered as the chain is entirely collapsed
  const hideVerticalConnector =
    showVerticalConnector &&
    props.node.value &&
    props.node instanceof ParentAutogroupNode &&
    !props.node.tail.children.length;

  return (
    <Fragment>
      {props.node.connectors.map((c, i) => {
        return (
          <div
            key={i}
            style={{
              left: -(
                Math.abs(Math.abs(c) - props.node.depth) * props.manager.row_depth_padding
              ),
            }}
            className={`TraceVerticalConnector ${c < 0 ? 'Orphaned' : ''}`}
          />
        );
      })}
      {showVerticalConnector && !hideVerticalConnector ? (
        <div className="TraceExpandedVerticalConnector" />
      ) : null}
      {props.node.isLastChild ? (
        <div className="TraceVerticalLastChildConnector" />
      ) : (
        <div className="TraceVerticalConnector" />
      )}
    </Fragment>
  );
}

function ChildrenButton(props: {
  children: React.ReactNode;
  expanded: boolean;
  icon: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  status: TraceTreeNode<any>['fetchStatus'] | undefined;
  errored?: boolean;
}) {
  return (
    <button
      className={`TraceChildrenCount ${props.errored ? 'Errored' : ''}`}
      onClick={props.onClick}
    >
      <div className="TraceChildrenCountContent">{props.children}</div>
      <div className="TraceChildrenCountAction">
        {props.icon}
        {props.status === 'loading' ? (
          <LoadingIndicator className="TraceActionsLoadingIndicator" size={8} />
        ) : null}
      </div>
    </button>
  );
}

interface TraceBarProps {
  color: string;
  manager: VirtualizedViewManager;
  node_space: [number, number] | null;
  virtualized_index: number;
  duration?: number;
}

function TraceBar(props: TraceBarProps) {
  if (!props.node_space) {
    return null;
  }

  const duration = getDuration(props.node_space[1] / 1000, 2, true);
  const spanTransform = props.manager.computeSpanCSSMatrixTransform(props.node_space);
  const [inside, textTransform] = props.manager.computeSpanTextPlacement(
    props.node_space,
    duration
  );

  return (
    <Fragment>
      <div
        ref={r =>
          props.manager.registerSpanBarRef(r, props.node_space!, props.virtualized_index)
        }
        className="TraceBar"
        style={{
          transform: `matrix(${spanTransform.join(',')})`,
          backgroundColor: props.color,
        }}
      />
      <div
        ref={r =>
          props.manager.registerSpanBarTextRef(
            r,
            duration,
            props.node_space!,
            props.virtualized_index
          )
        }
        className="TraceBarDuration"
        style={{
          color: inside ? 'white' : '',
          transform: `translate(${textTransform ?? 0}px, 0)`,
        }}
      >
        {duration}
      </div>
    </Fragment>
  );
}

interface AutogroupedTraceBarProps {
  color: string;
  entire_space: [number, number] | null;
  manager: VirtualizedViewManager;
  node_spaces: [number, number][];
  virtualized_index: number;
  duration?: number;
}

function AutogroupedTraceBar(props: AutogroupedTraceBarProps) {
  if (props.node_spaces && props.node_spaces.length <= 1) {
    return (
      <TraceBar
        color={props.color}
        node_space={props.entire_space}
        manager={props.manager}
        virtualized_index={props.virtualized_index}
        duration={props.duration}
      />
    );
  }

  if (!props.node_spaces || !props.entire_space) {
    return null;
  }

  const duration = getDuration(props.entire_space[1] / 1000, 2, true);
  const spanTransform = props.manager.computeSpanCSSMatrixTransform(props.entire_space);
  const [inside, textTransform] = props.manager.computeSpanTextPlacement(
    props.entire_space,
    duration
  );

  return (
    <Fragment>
      <div
        ref={r =>
          props.manager.registerSpanBarRef(
            r,
            props.entire_space!,
            props.virtualized_index
          )
        }
        className="TraceBar Invisible"
        style={{
          transform: `matrix(${spanTransform.join(',')})`,
          backgroundColor: props.color,
        }}
      >
        {props.node_spaces.map((node_space, i) => {
          const width = node_space[1] / props.entire_space![1];
          const left = (node_space[0] - props.entire_space![0]) / props.entire_space![1];
          return (
            <div
              key={i}
              className="TraceBar"
              style={{
                left: `${left * 1000}%`,
                width: `${width * 100}%`,
                backgroundColor: props.color,
              }}
            />
          );
        })}
      </div>
      <div
        ref={r =>
          props.manager.registerSpanBarTextRef(
            r,
            duration,
            props.entire_space!,
            props.virtualized_index
          )
        }
        className="TraceBarDuration"
        style={{
          color: inside ? 'white' : '',
          transform: `translate(${textTransform ?? 0}px, 0)`,
        }}
      >
        {duration}
      </div>
    </Fragment>
  );
}

/**
 * This is a wrapper around the Trace component to apply styles
 * to the trace tree. It exists because we _do not_ want to trigger
 * emotion's css parsing logic as it is very slow and will cause
 * the scrolling to flicker.
 */
const TraceStylingWrapper = styled('div')`
  height: 70vh;
  width: 100%;
  margin: auto;
  overflow: hidden;
  position: relative;
  box-shadow: 0 0 0 1px ${p => p.theme.border};
  border-radius: 4px;

  padding-top: 22px;

  &.WithIndicators {
    padding-top: 44px;

    &:before {
      height: 44px;
    }

    .TraceIndicator.Timeline {
      .TraceIndicatorLabel {
        top: 26px;
      }

      .TraceIndicatorLine {
        top: 30px;
      }
    }
  }

  &:before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 22px;
    background-color: ${p => p.theme.backgroundSecondary};
    border-bottom: 1px solid ${p => p.theme.border};
  }

  &.Loading {
    .TraceRow {
      .TraceLeftColumnInner {
        width: 100%;
      }
    }

    .TraceRightColumn {
      background-color: transparent !important;
    }

    .TraceDivider {
      pointer-events: none;
    }
  }

  .TraceDivider {
    position: absolute;
    height: 100%;
    background-color: transparent;
    top: 0;
    cursor: col-resize;
    z-index: 10;

    &:before {
      content: '';
      position: absolute;
      width: 1px;
      height: 100%;
      background-color: ${p => p.theme.border};
      left: 50%;
    }

    &:hover {
      &:before {
        background-color: ${p => p.theme.purple300};
      }
    }
  }

  .TraceIndicatorContainer {
    overflow: hidden;
    width: 100%;
    height: 100%;
    position: absolute;
    right: 0;
    top: 0;
  }

  .TraceIndicator {
    z-index: 1;
    width: 3px;
    height: 100%;
    top: 0;
    position: absolute;

    .TraceIndicatorLabel {
      min-width: 34px;
      text-align: center;
      position: absolute;
      font-size: ${p => p.theme.fontSizeExtraSmall};
      font-weight: bold;
      color: ${p => p.theme.textColor};
      background-color: ${p => p.theme.background};
      border-radius: ${p => p.theme.borderRadius};
      border: 1px solid ${p => p.theme.border};
      padding: 2px;
      display: inline-block;
      line-height: 1;
      margin-top: 2px;
      white-space: nowrap;
    }

    .TraceIndicatorLine {
      width: 1px;
      height: 100%;
      top: 20px;
      position: absolute;
      left: 50%;
      transform: translateX(-2px);
      background: repeating-linear-gradient(
          to bottom,
          transparent 0 4px,
          ${p => p.theme.textColor} 4px 8px
        )
        80%/2px 100% no-repeat;
    }

    &.Timeline {
      opacity: 1;
      z-index: 1;
      pointer-events: none;

      .TraceIndicatorLabel {
        font-weight: normal;
        min-width: 0;
        top: 2px;
        width: auto;
        border: none;
        background-color: transparent;
        color: ${p => p.theme.subText};
      }

      .TraceIndicatorLine {
        background: ${p => p.theme.translucentGray100};
        top: 4px;
      }
    }
  }

  .TraceRow {
    display: flex;
    align-items: center;
    position: absolute;
    height: 24px;
    width: 100%;
    transition: none;
    font-size: ${p => p.theme.fontSizeSmall};

    .Errored {
      color: ${p => p.theme.error};
    }

    .Link {
      &:hover {
        color: ${p => p.theme.blue300};
      }
    }

    .ErrorIconBorder {
      position: absolute;
      margin: 2px;
      left: -12px;
      background: ${p => p.theme.background};
      width: 20px;
      height: 20px;
      border: 1px solid ${p => p.theme.error};
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .TraceRightColumn.Odd {
      background-color: ${p => p.theme.backgroundSecondary};
    }

    &:hover {
      background-color: ${p => p.theme.backgroundSecondary};
    }

    &.Highlight,
    &:focus {
      outline: none;
      background-color: ${p => p.theme.backgroundTertiary};

      .TraceRightColumn.Odd {
        background-color: transparent !important;
      }
    }

    &:focus {
      box-shadow: inset 0 0 0 1px ${p => p.theme.blue300} !important;

      .TraceLeftColumn {
        box-shadow: inset 0px 0 0px 1px ${p => p.theme.blue300} !important;
      }
    }

    &.Highlight {
      box-shadow: inset 0 0 0 1px ${p => p.theme.blue200} !important;

      .TraceLeftColumn {
        box-shadow: inset 0px 0 0px 1px ${p => p.theme.blue200} !important;
      }
    }

    &.SearchResult {
      background-color: ${p => p.theme.yellow100};

      .TraceRightColumn {
        background-color: transparent;
      }
    }

    &.Autogrouped {
      color: ${p => p.theme.blue300};
      .TraceDescription {
        font-weight: bold;
      }
      .TraceChildrenCountWrapper {
        button {
          color: ${p => p.theme.white};
          background-color: ${p => p.theme.blue300};
        }
      }
    }
  }

  .TraceLeftColumn {
    height: 100%;
    white-space: nowrap;
    display: flex;
    align-items: center;
    overflow: hidden;
    will-change: width;
    box-shadow: inset 1px 0 0px 0px transparent;

    .TraceLeftColumnInner {
      height: 100%;
      white-space: nowrap;
      display: flex;
      align-items: center;
      will-change: transform;
      transform-origin: left center;

      img {
        width: 16px;
        height: 16px;
      }
    }
  }

  .TraceRightColumn {
    height: 100%;
    overflow: hidden;
    position: relative;
    display: flex;
    align-items: center;
    will-change: width;
    z-index: 1;

    &:hover {
      .TraceArrow.Visible {
        opacity: 1;
        transition: 300ms 300ms ease-out;
        pointer-events: auto;
      }
    }
  }

  .TraceBar {
    position: absolute;
    height: 64%;
    width: 100%;
    background-color: black;
    transform-origin: left center;

    &.Invisible {
      background-color: transparent !important;

      > div {
        height: 100%;
      }
    }
  }

  .TraceArrow {
    position: absolute;
    pointer-events: none;
    top: 0;
    width: 14px;
    height: 24px;
    opacity: 0;
    background-color: transparent;
    border: none;
    transition: 60ms ease-out;
    font-size: ${p => p.theme.fontSizeMedium};
    color: ${p => p.theme.subText};
    padding: 0 2px;
    display: flex;
    align-items: center;

    &.Left {
      left: 0;
    }
    &.Right {
      right: 0;
      transform: rotate(180deg);
    }
  }

  .TraceBarDuration {
    display: inline-block;
    transform-origin: left center;
    font-size: ${p => p.theme.fontSizeExtraSmall};
    color: ${p => p.theme.gray300};
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    position: absolute;
    transition: color 0.1s ease-in-out;
  }

  .TraceChildrenCount {
    height: 16px;
    white-space: nowrap;
    min-width: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 99px;
    padding: 0px 4px;
    transition: all 0.15s ease-in-out;
    background: ${p => p.theme.background};
    border: 2px solid ${p => p.theme.border};
    line-height: 0;
    z-index: 1;
    font-size: 10px;
    box-shadow: ${p => p.theme.dropShadowLight};
    margin-right: 8px;

    &.Errored {
      border: 2px solid ${p => p.theme.error};
    }

    .TraceChildrenCountContent {
      + .TraceChildrenCountAction {
        margin-left: 2px;
      }
    }

    .TraceChildrenCountAction {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .TraceActionsLoadingIndicator {
      margin: 0;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background-color: ${p => p.theme.background};

      animation: show 0.1s ease-in-out forwards;

      @keyframes show {
        from {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.86);
        }
        to {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
      }

      .loading-indicator {
        border-width: 2px;
      }

      .loading-message {
        display: none;
      }
    }

    svg {
      width: 7px;
      transition: none;
    }
  }

  .TraceChildrenCountWrapper {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    min-width: 44px;
    height: 100%;
    position: relative;

    button {
      transition: none;
    }

    &.Orphaned {
      .TraceVerticalConnector,
      .TraceVerticalLastChildConnector,
      .TraceExpandedVerticalConnector {
        border-left: 2px dashed ${p => p.theme.border};
      }

      &::before {
        border-bottom: 2px dashed ${p => p.theme.border};
      }
    }

    &.Root {
      &:before,
      .TraceVerticalLastChildConnector {
        visibility: hidden;
      }
    }

    &::before {
      content: '';
      display: block;
      width: 50%;
      height: 2px;
      border-bottom: 2px solid ${p => p.theme.border};
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
    }

    &::after {
      content: '';
      background-color: ${p => p.theme.border};
      border-radius: 50%;
      height: 6px;
      width: 6px;
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translateY(-50%);
    }
  }

  .TraceVerticalConnector {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    height: 100%;
    width: 2px;
    border-left: 2px solid ${p => p.theme.border};

    &.Orphaned {
      border-left: 2px dashed ${p => p.theme.border};
    }
  }

  .TraceVerticalLastChildConnector {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    height: 50%;
    width: 2px;
    border-left: 2px solid ${p => p.theme.border};
    border-bottom-left-radius: 4px;
  }

  .TraceExpandedVerticalConnector {
    position: absolute;
    bottom: 0;
    height: 50%;
    left: 50%;
    width: 2px;
    border-left: 2px solid ${p => p.theme.border};
  }

  .TraceOperation {
    margin-left: 4px;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: bold;
  }

  .TraceEmDash {
    margin-left: 4px;
    margin-right: 4px;
  }

  .TraceDescription {
    white-space: nowrap;
  }
`;

const LoadingContainer = styled('div')`
  display: flex;
  justify-content: center;
  align-items: center;
  flex-direction: column;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  position: absolute;
  height: auto;
  font-size: ${p => p.theme.fontSizeMedium};
  color: ${p => p.theme.gray300};
  z-index: 30;
  padding: 24px;
  background-color: ${p => p.theme.background};
  border-radius: ${p => p.theme.borderRadius};
  border: 1px solid ${p => p.theme.border};
`;

function TraceLoading() {
  return (
    <LoadingContainer>
      <NoMarginIndicator size={24}>
        <div>{t('Assembling the trace')}</div>
      </NoMarginIndicator>
    </LoadingContainer>
  );
}

const NoMarginIndicator = styled(LoadingIndicator)`
  margin: 0;
`;

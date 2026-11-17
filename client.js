window.__ModuleLoader__.load({
  id: 'dsh-session-panel',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * Session panel — browser entry.
     *
     * ONE self-contained artifact. It must never `require` a relative path: the
     * client module loader wraps this file in `window.__ModuleLoader__.load` and
     * has no other file to resolve against, so a relative specifier fails
     * everywhere it appears. The only import is `react`, which the loader's
     * module table already holds. Harness client packages are deliberately not
     * imported: slots arrive as the `slots` service, locale as `locale`, and
     * every control here is written in this file.
     *
     * What it shows:
     *
     * - one sidebar row (`sidebar.panellist`, order 11, directly below the
     *   shipped Automation tasks row at order 10),
     * - one main panel (`main` keyed `session-panel`) with two view modes,
     * - a click on a card opens that Session.
     *
     * The two modes:
     *
     * - **Workspace** (default): sections per Workspace. Pinning reorders inside
     *   a section and lifts the whole section; it never pulls a Session out of
     *   its Workspace, which would cut one Workspace into two halves.
     * - **Global recent**: one flat list. Pinned Sessions rise into a pinned
     *   block above a rule, and everything below is the rest.
     *
     * Ordering is one shared rule in both modes — pinned-and-busy, pinned, busy,
     * idle, then most recent within a tier. Pinned-and-busy is the only top tier,
     * so a pinned busy Session leads a pinned idle one even when the idle one was
     * touched later.
     *
     * Two pin sources, deliberately kept apart:
     *
     * - **Session pins** are the Harness's own (`ctx.uiWorkspace.pinSession`),
     *   shared with the sidebar. Pinning here and pinning there are the same
     *   fact, so the panel owns no second copy.
     * - **Workspace pins** have no Harness equivalent (`WorkspaceView` carries no
     *   pinned field), so this plugin stores them in a JSON file under the
     *   Harness home through its own loopback route. They follow the folder, not
     *   the title, so a rename keeps the pin and a re-added folder gets it back.
     *
     * Styles take colour exclusively from `--dsw-alias-*` / `--dsw-radius-*`
     * theme tokens so light and dark both read correctly, and they are rendered
     * as a component-local `<style>` element, which unmounting removes.
     *
     * Layout of this file:
     *   1. copy (zh/en) and the translator
     *   2. constants and the pin route client
     *   3. state derivation (nodes, grouping, ordering)
     *   4. the view components
     *   5. styles
     *   6. `apply`: dictionary, the two slot registrations
     */

    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useRef = React.useRef;
    const useSyncExternalStore = React.useSyncExternalStore;

    // =========================================================================
    // 1. Copy
    // =========================================================================

    /** Dictionary namespace registered through `locale.register`. */
    const DICT_NS = 'dsh-session-panel';

    /**
     * Both languages inline, identical to `locale/zh.json` and `locale/en.json`.
     *
     * The inline table is the fallback chain's end: `locale.bind(ns)` answers
     * with the bare key when the namespace has no dictionary (a reload, or a
     * composition without the locale plugin), and raw keys on screen would be a
     * worse degradation than English.
     */
    const DICT = {
      zh: {
        'panel': '会话面板',
        'page.title': '会话面板',
        'page.subtitle.workspace': '按工作区查看全部会话，点开任意一张卡片即可回到那个对话。',
        'page.subtitle.flat': '全部会话按优先级排列，不区分工作区。',
        'page.count.workspace': '{count} 个会话 · {groups} 个工作区',
        'page.count.flat': '{count} 个会话 · 全部工作区',
        'page.count.pinned': ' · {count} 个置顶',
        'page.empty': '还没有会话。在左侧新建一个对话后，这里就会出现。',
        'page.showArchived': '显示已归档',
        'page.hideArchived': '隐藏已归档',
        'mode.label': '视图',
        'mode.workspace': '工作区相关',
        'mode.flat': '全局最近活跃',
        'section.pinned': '置顶',
        'section.recent': '最近活跃',
        'pin.pin': '置顶',
        'pin.unpin': '取消置顶',
        'pin.workspace': '置顶工作区',
        'pin.workspaceOn': '已置顶',
        'pin.workspaceLocked': '该工作区已整体置顶',
        'pin.failed': '置顶状态没能保存',
        'pin.corrupt': '置顶配置文件已损坏，改动没有写进去。修好 {file} 后点重试。',
        'pin.retry': '重试',
        'status.running': '运行中',
        'status.approval': '等待批准',
        'status.planReview': '等待计划评审',
        'status.question': '等待回答',
        'status.done': '刚完成',
        'status.idle': '空闲',
        'group.ungrouped': '未分组',
        'group.more': '还有 {count} 个',
        'group.less': '收起',
        'card.untitled': '未命名会话',
        'card.archived': '已归档',
        'time.justNow': '刚刚',
        'time.minutes': '{count} 分钟前',
        'time.hours': '{count} 小时前',
        'time.days': '{count} 天前',
      },
      en: {
        'panel': 'Session panel',
        'page.title': 'Session panel',
        'page.subtitle.workspace': 'Every session by workspace. Click a card to return to that conversation.',
        'page.subtitle.flat': 'Every session in priority order, across all workspaces.',
        'page.count.workspace': '{count} sessions · {groups} workspaces',
        'page.count.flat': '{count} sessions · all workspaces',
        'page.count.pinned': ' · {count} pinned',
        'page.empty': 'No sessions yet. Start one from the sidebar and it shows up here.',
        'page.showArchived': 'Show archived',
        'page.hideArchived': 'Hide archived',
        'mode.label': 'View',
        'mode.workspace': 'By workspace',
        'mode.flat': 'Recent everywhere',
        'section.pinned': 'Pinned',
        'section.recent': 'Recent',
        'pin.pin': 'Pin',
        'pin.unpin': 'Unpin',
        'pin.workspace': 'Pin workspace',
        'pin.workspaceOn': 'Pinned',
        'pin.workspaceLocked': 'This workspace is pinned as a whole',
        'pin.failed': 'The pin could not be saved',
        'pin.corrupt': 'The pin file is damaged, so nothing was written. Fix {file} and retry.',
        'pin.retry': 'Retry',
        'status.running': 'Running',
        'status.approval': 'Waiting for approval',
        'status.planReview': 'Plan awaiting review',
        'status.question': 'Waiting for answer',
        'status.done': 'Just finished',
        'status.idle': 'Idle',
        'group.ungrouped': 'Ungrouped',
        'group.more': '{count} more',
        'group.less': 'Show less',
        'card.untitled': 'Untitled session',
        'card.archived': 'Archived',
        'time.justNow': 'just now',
        'time.minutes': '{count} min ago',
        'time.hours': '{count} h ago',
        'time.days': '{count} d ago',
      },
    };

    /**
     * Build the translator over an optional locale service.
     *
     * `locale.bind(ns)` is preferred (it follows the app language live); when the
     * service or the namespace is missing, English from the inline table answers
     * every key.
     *
     * @param {any} locale the locale service, or undefined
     */
    function createTranslator(locale) {
      return function t(key, params) {
        var table = DICT.en;
        if (locale !== undefined && typeof locale.bind === 'function') {
          try {
            var bound = locale.bind(DICT_NS);
            if (typeof bound === 'function') {
              var resolved = bound(key, params);
              // `bind` answers with the bare key when the namespace is absent.
              if (typeof resolved === 'string' && resolved !== key) return resolved;
            }
          } catch {
            /* fall back to the inline table */
          }
        }
        var text = table[key];
        if (typeof text !== 'string') return key;
        if (params !== undefined && params !== null) {
          text = text.replace(/\{(\w+)\}/g, function (match, name) {
            return Object.prototype.hasOwnProperty.call(params, name)
              ? String(params[name])
              : match;
          });
        }
        return text;
      };
    }

    // =========================================================================
    // 2. Constants and the pin route client
    // =========================================================================

    /** Sessions per group before the group folds its overflow away. */
    const GROUP_LIMIT = 8;

    /** View modes. */
    const MODE_WORKSPACE = 'workspace';
    const MODE_FLAT = 'flat';

    /** Where the chosen mode is remembered between reloads. */
    const MODE_STORAGE_KEY = 'dsh-session-panel.mode';

    /**
     * The Host routes this panel talks to; mirrors `lib/routes.js`.
     *
     * The `/plugins/<name>/` prefix is required — a bare path registers on the
     * Host but is never reached, because the Web composition's fallback owns
     * every path outside the reserved prefixes.
     */
    const ROUTE_PATHS = {
      state: '/plugins/dsh-session-panel/state',
      pin: '/plugins/dsh-session-panel/pin',
      reload: '/plugins/dsh-session-panel/reload',
    };

    /** Remember the mode, tolerating a browser that refuses storage. */
    function readStoredMode() {
      try {
        if (typeof localStorage === 'undefined') return MODE_WORKSPACE;
        var raw = localStorage.getItem(MODE_STORAGE_KEY);
        return raw === MODE_FLAT ? MODE_FLAT : MODE_WORKSPACE;
      } catch {
        return MODE_WORKSPACE;
      }
    }

    /** @param {string} mode */
    function storeMode(mode) {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(MODE_STORAGE_KEY, mode);
      } catch {
        /* a read-only profile keeps the default */
      }
    }

    /**
     * The Host-backed workspace pin set.
     *
     * One observable so every component reads the same source and a write shows
     * up everywhere at once. Writes are optimistic: the set updates immediately
     * and rolls back if the Host refuses, which keeps a click responsive while
     * never claiming a value that did not reach disk.
     *
     * A rejected write is surfaced through `error` rather than swallowed, because
     * a pin the user believes in but the file does not hold is the one failure
     * this feature must not hide.
     */
    function createPinClient() {
      var snapshot = { paths: [], corrupt: false, error: null, loading: true };
      var listeners = new Set();

      function publish(next) {
        snapshot = next;
        listeners.forEach(function (listener) {
          try {
            listener();
          } catch {
            /* a broken subscriber must not stop the rest */
          }
        });
      }

      function request(url, init) {
        return fetch(url, init).then(function (response) {
          return response.json().then(function (body) {
            if (!response.ok) {
              var message = body !== null && typeof body === 'object' && typeof body.error === 'string'
                ? body.error
                : 'HTTP ' + response.status;
              throw new Error(message);
            }
            return body;
          });
        });
      }

      function adopt(body) {
        var paths = body !== null && typeof body === 'object' && Array.isArray(body.pinnedWorkspaces)
          ? body.pinnedWorkspaces.filter(function (entry) { return typeof entry === 'string'; })
          : [];
        publish({
          paths: paths,
          corrupt: body !== null && typeof body === 'object' && body.corrupt === true,
          error: null,
          loading: false,
        });
      }

      return {
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
        getSnapshot: function () { return snapshot; },

        /** Read the set once at startup. A failure is reported, not thrown. */
        load: function () {
          return request(ROUTE_PATHS.state, { method: 'GET' })
            .then(adopt)
            .catch(function (error) {
              publish({
                paths: snapshot.paths,
                corrupt: snapshot.corrupt,
                error: error instanceof Error ? error.message : String(error),
                loading: false,
              });
            });
        },

        /**
         * Pin or unpin one workspace path.
         *
         * @param {string} path
         * @param {boolean} pinned
         */
        set: function (path, pinned) {
          var previous = snapshot;
          var next = previous.paths.filter(function (entry) { return entry !== path; });
          if (pinned) next = next.concat([path]);
          // Optimistic: the click responds before the round trip.
          publish({ paths: next, corrupt: previous.corrupt, error: null, loading: false });
          return request(ROUTE_PATHS.pin, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path, pinned: pinned }),
          }).then(adopt).catch(function (error) {
            publish({
              paths: previous.paths,
              corrupt: previous.corrupt,
              error: error instanceof Error ? error.message : String(error),
              loading: false,
            });
          });
        },

        /** Re-read the file after the user fixed a damaged one. */
        retry: function () {
          return request(ROUTE_PATHS.reload, { method: 'POST' }).then(adopt).catch(function (error) {
            publish({
              paths: snapshot.paths,
              corrupt: snapshot.corrupt,
              error: error instanceof Error ? error.message : String(error),
              loading: false,
            });
          });
        },
      };
    }

    // =========================================================================
    // 3. State derivation
    // =========================================================================

    /** Trailing path segment, tolerating both separators. */
    function basename(path) {
      if (typeof path !== 'string' || path === '') return '';
      var trimmed = path.replace(/[/\\]+$/, '');
      var cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      return trimmed.slice(cut + 1);
    }

    /**
     * Canonical form of a workspace path, matching `lib/store.js`.
     *
     * The Host is the authority; this mirror exists so an optimistic update can
     * compare a live `WorkspaceView.path` against a stored entry without a round
     * trip.
     *
     * @param {unknown} value
     * @returns {string}
     */
    function normalizePath(value) {
      if (typeof value !== 'string') return '';
      var trimmed = value.trim();
      if (trimmed === '') return '';
      var stripped = trimmed.replace(/[/\\]+$/, '');
      var normalized = stripped === '' ? trimmed.slice(0, 1) : stripped;
      return normalized === '' ? '' : normalized;
    }

    /** Relative age in the reader's language. */
    function relativeTime(t, updatedAt, now) {
      if (typeof updatedAt !== 'number' || !isFinite(updatedAt)) return '';
      var delta = now - updatedAt;
      if (delta < 0) return t('time.justNow');
      var minutes = Math.floor(delta / 60000);
      if (minutes < 1) return t('time.justNow');
      if (minutes < 60) return t('time.minutes', { count: minutes });
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return t('time.hours', { count: hours });
      return t('time.days', { count: Math.floor(hours / 24) });
    }

    /**
     * Collapse the three independent status facts into one presentation key.
     *
     * Precedence follows the sidebar row: a pending interaction outranks running,
     * which outranks the finished-but-unopened reminder.
     *
     * @param {any} status one entry of the Session status snapshot
     * @returns {'approval'|'planReview'|'question'|'running'|'done'|'idle'}
     */
    function statusOf(status) {
      var pending = status === undefined || status === null ? undefined : status.pendingInteraction;
      if (pending !== undefined && pending !== null) {
        var kind = pending.kind;
        if (kind === 'approval') return 'approval';
        if (kind === 'plan-review') return 'planReview';
        if (kind === 'question') return 'question';
        // An unknown domain still means the user is being waited on.
        return 'question';
      }
      if (status !== undefined && status !== null && status.running === true) return 'running';
      if (status !== undefined && status !== null && status.completionUnread === true) return 'done';
      return 'idle';
    }

    /** Localized status label for one presentation key. */
    function statusLabel(t, key) {
      switch (key) {
        case 'approval': return t('status.approval');
        case 'planReview': return t('status.planReview');
        case 'question': return t('status.question');
        case 'running': return t('status.running');
        case 'done': return t('status.done');
        default: return t('status.idle');
      }
    }

    /** Is this status "work in flight" for ordering purposes? */
    function isBusy(node) {
      return node.status !== 'idle' && node.status !== 'done';
    }

    /**
     * Priority tier, expressed as one number so a single comparator can sort.
     *
     * `pinned-and-busy` is the only tier 0: a pinned Session that is running
     * leads a pinned Session that is idle even when the idle one was touched
     * later. That is the user's stated rule and the reason this is not a plain
     * timestamp sort.
     *
     * @param {{ pinned: boolean, status: string }} node
     * @returns {0|1|2|3}
     */
    function tierOf(node) {
      var pinTier = node.pinned ? 0 : 1;
      var busyTier = isBusy(node) ? 0 : 1;
      return pinTier * 2 + busyTier;
    }

    /** Shared comparator: tier ascending, then most recent first. */
    function byTier(left, right) {
      var a = tierOf(left);
      var b = tierOf(right);
      if (a !== b) return a - b;
      if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }

    /**
     * Build the flat node list every view renders.
     *
     * One pass over the Session catalog, joined against the Workspace snapshot
     * for grouping and the two pin sources. Returning nodes (rather than view
     * shapes) keeps both modes fed from exactly the same data, so switching modes
     * can only rearrange, never change which Sessions appear.
     *
     * @param {any} list the Session list snapshot
     * @param {any} workspaceSnapshot the Workspace list snapshot
     * @param {Map} statuses the Session status snapshot
     * @param {boolean} showArchived whether archived Sessions are included
     * @param {Set<string>} pinnedWorkspacePaths workspace paths pinned by this plugin
     */
    function buildNodes(list, workspaceSnapshot, statuses, showArchived, pinnedWorkspacePaths) {
      var byId = (list !== undefined && list !== null && list.byId) || {};
      var workspaces = (workspaceSnapshot !== undefined && workspaceSnapshot !== null
        && Array.isArray(workspaceSnapshot.items)) ? workspaceSnapshot.items : [];
      var archivedIds = (workspaceSnapshot !== undefined && workspaceSnapshot !== null
        && Array.isArray(workspaceSnapshot.archivedSessionIds))
        ? workspaceSnapshot.archivedSessionIds : [];
      var pinnedSessionIds = (workspaceSnapshot !== undefined && workspaceSnapshot !== null
        && Array.isArray(workspaceSnapshot.pinnedSessionIds))
        ? workspaceSnapshot.pinnedSessionIds : [];

      var archived = new Set(archivedIds);
      var sessionPins = new Set(pinnedSessionIds);
      // Duck-type the pin set instead of `instanceof Set`: a Set built in
      // another realm (a test harness, or any code that hands one across a
      // boundary) fails an `instanceof` check while behaving identically, and a
      // silently dropped pin set would look like every pin was lost.
      var workspacePins = pinnedWorkspacePaths !== undefined
        && pinnedWorkspacePaths !== null
        && typeof pinnedWorkspacePaths.has === 'function'
        ? pinnedWorkspacePaths
        : new Set();

      /** Owning workspace per Session, plus the workspace row itself. */
      var ownerOf = new Map();
      for (var w = 0; w < workspaces.length; w += 1) {
        var workspace = workspaces[w];
        var ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
        for (var s = 0; s < ids.length; s += 1) ownerOf.set(ids[s], workspace);
      }

      var rowIds = Array.isArray(list === undefined || list === null ? undefined : list.ids)
        ? list.ids : Object.keys(byId);
      var nodes = [];

      for (var i = 0; i < rowIds.length; i += 1) {
        var id = rowIds[i];
        var row = byId[id];
        if (row === undefined || row === null) continue;
        // A blank Session is the New Session placeholder, not work in progress.
        if (row.blank === true) continue;
        // Subagent children are part of their parent's story, not separate cards.
        if (row.origin === 'subagent' || row.parentId !== undefined) continue;
        var isArchived = archived.has(id);
        if (isArchived && showArchived !== true) continue;

        var owner = ownerOf.get(id);
        var workspacePath = owner === undefined ? '' : normalizePath(owner.path);
        var workspacePinned = workspacePath !== '' && workspacePins.has(workspacePath);
        var status = statuses === undefined ? undefined : statuses.get(id);

        nodes.push({
          id: id,
          title: typeof row.title === 'string' && row.title.trim() !== ''
            ? row.title.trim()
            : (typeof row.displayTitle === 'string' && row.displayTitle.trim() !== ''
              ? row.displayTitle.trim()
              : ''),
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
          cwd: typeof row.cwd === 'string' ? row.cwd : '',
          workspaceId: owner === undefined ? '' : String(owner.workspaceId),
          workspacePath: workspacePath,
          workspaceLabel: owner === undefined
            ? ''
            : (typeof owner.title === 'string' && owner.title !== ''
              ? owner.title
              : basename(owner.path)),
          archived: isArchived,
          // A workspace pin implies pins for everything inside it.
          pinned: sessionPins.has(id) || workspacePinned,
          pinnedByWorkspace: workspacePinned,
          status: statusOf(status),
        });
        if (nodes[nodes.length - 1].archived === true) {
          nodes[nodes.length - 1].pinned = false;
          nodes[nodes.length - 1].pinnedByWorkspace = false;
        }
      }

      return nodes;
    }

    /**
     * Group nodes by workspace for the workspace view.
     *
     * A group's own priority is the best tier it contains, so a workspace holding
     * a pinned busy Session leads one holding only pinned idle Sessions. Groups
     * with no workspace (an orphaned Session) land in a single ungrouped bucket.
     *
     * Pinned Sessions stay inside their group: pulling them out would render the
     * same workspace twice and break the grouping the mode promises.
     *
     * @param {readonly any[]} nodes
     */
    function buildGroups(nodes) {
      var buckets = new Map();
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        var key = node.workspaceId === '' ? '' : node.workspaceId;
        var bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = {
            key: key,
            label: node.workspaceLabel,
            path: node.workspacePath,
            sessions: [],
            hasPinned: false,
          };
          buckets.set(key, bucket);
        }
        bucket.sessions.push(node);
        if (node.pinned) bucket.hasPinned = true;
      }

      var groups = [];
      buckets.forEach(function (bucket) {
        bucket.sessions.sort(byTier);
        bucket.bestTier = bucket.sessions.reduce(function (best, node) {
          var tier = tierOf(node);
          return tier < best ? tier : best;
        }, 3);
        bucket.latest = bucket.sessions.reduce(function (latest, node) {
          return node.updatedAt > latest ? node.updatedAt : latest;
        }, 0);
        groups.push(bucket);
      });

      groups.sort(function (left, right) {
        // A group containing pinned work leads; then the best tier; then recency.
        if (left.hasPinned !== right.hasPinned) return left.hasPinned ? -1 : 1;
        if (left.bestTier !== right.bestTier) return left.bestTier - right.bestTier;
        if (left.latest !== right.latest) return right.latest - left.latest;
        return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
      });

      return groups;
    }

    /**
     * Split the flat list into the pinned block and the rest.
     *
     * @param {readonly any[]} nodes
     */
    function buildFlat(nodes) {
      var pinned = [];
      var rest = [];
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i].pinned) pinned.push(nodes[i]);
        else rest.push(nodes[i]);
      }
      pinned.sort(byTier);
      rest.sort(byTier);
      return { pinned: pinned, rest: rest };
    }

    // =========================================================================
    // 4. View
    // =========================================================================

    /** The status dot. */
    function StatusDot(props) {
      return h('span', {
        className: 'sessionPanel__dot sessionPanel__dot--' + props.status,
        'aria-hidden': 'true',
      });
    }

    /** The pin glyph: a pin seen face-on, readable at 13px. */
    var PIN_GLYPH = 'M5.6 2.4h4.8a.9.9 0 0 1 0 1.8h-.4v3.5l1.9 2.1a.75.75 0 0 1-.56 1.25H4.66'
      + 'a.75.75 0 0 1-.56-1.25l1.9-2.1V4.2h-.4a.9.9 0 0 1 0-1.8zM7.1 11.4h1.8L8 14.2z';

    function pinIcon(size) {
      var edge = size || 13;
      return h('svg', {
        viewBox: '0 0 16 16',
        width: edge,
        height: edge,
        'aria-hidden': 'true',
        style: { display: 'block' },
      }, h('path', { d: PIN_GLYPH, fill: 'currentColor' }));
    }

    /**
     * One Session card.
     *
     * The whole card is the click target for navigation; the pin button sits
     * absolutely positioned over it and stops propagation, so pinning never
     * navigates. An archived card is disabled: the browser cannot open an
     * archived Session until it is restored.
     */
    function SessionCard(props) {
      var node = props.node;
      var t = props.t;
      var locked = node.pinnedByWorkspace;
      var pinTitle = locked ? t('pin.workspaceLocked') : (node.pinned ? t('pin.unpin') : t('pin.pin'));
      var title = node.title !== '' ? node.title : t('card.untitled');

      return h('div', {
        className: 'sessionPanel__card'
          + (node.pinned ? ' sessionPanel__card--pinned' : '')
          + (node.archived ? ' sessionPanel__card--archived' : ''),
        role: 'button',
        tabIndex: node.archived ? -1 : 0,
        'aria-disabled': node.archived === true ? 'true' : undefined,
        title: node.archived ? t('card.archived') : title,
        onClick: function () {
          if (node.archived === true) return;
          props.onOpen(node.id);
        },
        onKeyDown: function (event) {
          if (node.archived === true) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            props.onOpen(node.id);
          }
        },
      }, [
        h('span', { key: 'dot', className: 'sessionPanel__cardDot' },
          h(StatusDot, { status: node.status })),
        h('span', { key: 'body', className: 'sessionPanel__cardBody' }, [
          h('span', { key: 'title', className: 'sessionPanel__cardTitle' }, title),
          h('span', { key: 'meta', className: 'sessionPanel__cardMeta' }, [
            h('span', { key: 'status', className: 'sessionPanel__cardStatus' },
              statusLabel(t, node.status)),
            // The workspace label matters most in the flat list, where Sessions
            // from one workspace scatter; in grouped mode the section header
            // already says it, so the caller decides.
            props.showWorkspace === true && node.workspaceLabel !== ''
              ? h('span', { key: 'ws', className: 'sessionPanel__cardWs' }, node.workspaceLabel)
              : null,
            h('span', { key: 'time', className: 'sessionPanel__cardTime' },
              relativeTime(t, node.updatedAt, props.now)),
          ]),
        ]),
        node.archived === true
          ? null
          : h('button', {
            key: 'pin',
            type: 'button',
            className: 'sessionPanel__pin'
              + (node.pinned ? ' sessionPanel__pin--on' : '')
              + (locked ? ' sessionPanel__pin--locked' : ''),
            title: pinTitle,
            'aria-label': pinTitle,
            'aria-pressed': node.pinned ? 'true' : 'false',
            onClick: function (event) {
              // Never navigate when the user meant to pin.
              event.stopPropagation();
              event.preventDefault();
              if (locked) return;
              props.onTogglePin(node);
            },
          }, pinIcon(13)),
      ]);
    }

    /** The rule that separates the pinned block from recent activity. */
    function SectionRule(props) {
      return h('div', { className: 'sessionPanel__rule' }, [
        h('span', { key: 'a', className: 'sessionPanel__ruleLine' }),
        h('span', { key: 'b', className: 'sessionPanel__ruleText' }, props.label),
        h('span', { key: 'c', className: 'sessionPanel__ruleLine' }),
      ]);
    }

    /** A section heading for the flat list. */
    function SectionLabel(props) {
      return h('div', { className: 'sessionPanel__sectionLabel' }, [
        h('span', { key: 'i', className: 'sessionPanel__sectionGlyph' }, pinIcon(11)),
        h('span', { key: 't' }, props.label),
      ]);
    }

    /** One workspace section in grouped mode. */
    function WorkspaceGroup(props) {
      var group = props.group;
      var t = props.t;
      var expanded = props.expanded;
      var visible = expanded ? group.sessions : group.sessions.slice(0, GROUP_LIMIT);
      var hidden = group.sessions.length - visible.length;
      var pinnedGroup = group.path !== '' && props.pinnedPaths.has(group.path);

      return h('section', { className: 'sessionPanel__group' }, [
        h('div', { key: 'head', className: 'sessionPanel__groupHead' }, [
          h('span', { key: 'name', className: 'sessionPanel__groupName' },
            group.label !== '' ? group.label : t('group.ungrouped')),
          h('span', { key: 'count', className: 'sessionPanel__groupCount' },
            String(group.sessions.length)),
          group.path !== ''
            ? h('button', {
              key: 'pin',
              type: 'button',
              className: 'sessionPanel__wsPin' + (pinnedGroup ? ' sessionPanel__wsPin--on' : ''),
              title: pinnedGroup ? t('pin.unpin') : t('pin.workspace'),
              'aria-pressed': pinnedGroup ? 'true' : 'false',
              onClick: function () { props.onToggleWorkspacePin(group.path, !pinnedGroup); },
            }, [
              h('span', { key: 'i', className: 'sessionPanel__wsPinGlyph' }, pinIcon(11)),
              h('span', { key: 'l' }, pinnedGroup ? t('pin.workspaceOn') : t('pin.workspace')),
            ])
            : null,
        ]),
        group.path !== ''
          ? h('div', { key: 'path', className: 'sessionPanel__groupPath' }, group.path)
          : null,
        h('div', { key: 'list', className: 'sessionPanel__cards' },
          visible.map(function (node) {
            return h(SessionCard, {
              key: node.id,
              node: node,
              t: t,
              now: props.now,
              showWorkspace: false,
              onOpen: props.onOpen,
              onTogglePin: props.onTogglePin,
            });
          })),
        hidden > 0
          ? h('button', {
            key: 'more',
            type: 'button',
            className: 'sessionPanel__more',
            onClick: function () { props.onToggle(group.key); },
          }, t('group.more', { count: hidden }))
          : (expanded && group.sessions.length > GROUP_LIMIT
            ? h('button', {
              key: 'less',
              type: 'button',
              className: 'sessionPanel__more',
              onClick: function () { props.onToggle(group.key); },
            }, t('group.less'))
            : null),
      ]);
    }

    /** The mode switch: two mutually exclusive views. */
    function ModeSwitch(props) {
      var t = props.t;
      var options = [
        { key: MODE_WORKSPACE, label: t('mode.workspace') },
        { key: MODE_FLAT, label: t('mode.flat') },
      ];
      return h('div', {
        className: 'sessionPanel__segmented',
        role: 'group',
        'aria-label': t('mode.label'),
      }, options.map(function (option) {
        var selected = props.mode === option.key;
        return h('button', {
          key: option.key,
          type: 'button',
          className: 'sessionPanel__segmentedItem'
            + (selected ? ' sessionPanel__segmentedItem--on' : ''),
          'aria-pressed': selected ? 'true' : 'false',
          onClick: function () { props.onChange(option.key); },
        }, option.label);
      }));
    }

    /**
     * The page.
     *
     * `useSessions`, `useWorkspaces` and `useSessionStatus` are root-scope
     * standard props the Harness renderer supplies to every slot, so this
     * component subscribes to the slices it needs and the framework handles
     * incremental publication.
     */
    function SessionPanelPage(props) {
      var t = props.t;
      var useSessions = props.useSessions;
      var useWorkspaces = props.useWorkspaces;
      var useSessionStatus = props.useSessionStatus;

      var list = useSessions(function (state) { return state; });
      var workspaceSnapshot = useWorkspaces(function (state) { return state; });
      var statuses = useSessionStatus(function (state) { return state; });
      // The third argument is React's server-render snapshot. The Harness mounts
      // this page in the browser, but omitting it makes any server render of the
      // component throw instead of degrading, so it is supplied for free.
      var pins = useSyncExternalStore(
        props.pinClient.subscribe,
        props.pinClient.getSnapshot,
        props.pinClient.getSnapshot,
      );

      var modeState = useState(readStoredMode);
      var mode = modeState[0];
      var setMode = modeState[1];

      var showArchivedState = useState(false);
      var showArchived = showArchivedState[0];
      var setShowArchived = showArchivedState[1];

      var expandedState = useState(function () { return []; });
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];

      // One clock for every relative label, refreshed on the minute boundary
      // rather than per render, so a page sitting open does not tick forever.
      var nowState = useState(function () { return Date.now(); });
      var now = nowState[0];
      var setNow = nowState[1];
      useEffect(function () {
        var timer = setInterval(function () { setNow(Date.now()); }, 60000);
        return function () { clearInterval(timer); };
      }, []);

      var pinnedPaths = useMemo(function () {
        return new Set(pins.paths);
      }, [pins.paths]);

      var nodes = useMemo(function () {
        return buildNodes(list, workspaceSnapshot, statuses, showArchived, pinnedPaths);
      }, [list, workspaceSnapshot, statuses, showArchived, pinnedPaths]);

      var groups = useMemo(function () {
        return mode === MODE_WORKSPACE ? buildGroups(nodes) : [];
      }, [nodes, mode]);

      var flat = useMemo(function () {
        return mode === MODE_FLAT ? buildFlat(nodes) : { pinned: [], rest: [] };
      }, [nodes, mode]);

      function changeMode(next) {
        if (next !== MODE_WORKSPACE && next !== MODE_FLAT) return;
        setMode(next);
        storeMode(next);
      }

      function toggleExpanded(key) {
        setExpanded(function (current) {
          return current.indexOf(key) < 0
            ? current.concat([key])
            : current.filter(function (entry) { return entry !== key; });
        });
      }

      function toggleSessionPin(node) {
        // A workspace pin already covers this Session; the Host call would be a
        // no-op the user did not ask for.
        if (node.pinnedByWorkspace) return;
        props.onToggleSessionPin(node.id, !node.pinned);
      }

      var pinnedCount = nodes.reduce(function (count, node) {
        return node.pinned ? count + 1 : count;
      }, 0);

      var countText = (mode === MODE_WORKSPACE
        ? t('page.count.workspace', { count: nodes.length, groups: groups.length })
        : t('page.count.flat', { count: nodes.length }))
        + (pinnedCount > 0 ? t('page.count.pinned', { count: pinnedCount }) : '');

      var workspaceCount = new Set(nodes.map(function (node) { return node.workspaceId; })).size;
      var headline = mode === MODE_WORKSPACE
        ? t('page.count.workspace', { count: nodes.length, groups: workspaceCount })
        : t('page.count.flat', { count: nodes.length });

      var body;
      if (nodes.length === 0) {
        body = h('div', { className: 'sessionPanel__empty' }, t('page.empty'));
      } else if (mode === MODE_WORKSPACE) {
        body = groups.map(function (group) {
          return h(WorkspaceGroup, {
            key: group.key === '' ? 'ungrouped' : group.key,
            group: group,
            t: t,
            now: now,
            expanded: expanded.indexOf(group.key) >= 0,
            pinnedPaths: pinnedPaths,
            onToggle: toggleExpanded,
            onOpen: props.onOpen,
            onTogglePin: toggleSessionPin,
            onToggleWorkspacePin: props.onToggleWorkspacePin,
          });
        });
      } else {
        var flatParts = [];
        if (flat.pinned.length > 0) {
          flatParts.push(h(SectionLabel, { key: 'label', label: t('section.pinned') }));
          flatParts.push(h('div', { key: 'pinned', className: 'sessionPanel__flatList' },
            flat.pinned.map(function (node) {
              return h(SessionCard, {
                key: node.id,
                node: node,
                t: t,
                now: now,
                showWorkspace: true,
                onOpen: props.onOpen,
                onTogglePin: toggleSessionPin,
              });
            })));
        }
        if (flat.pinned.length > 0 && flat.rest.length > 0) {
          flatParts.push(h(SectionRule, { key: 'rule', label: t('section.recent') }));
        }
        flatParts.push(h('div', { key: 'rest', className: 'sessionPanel__flatList' },
          flat.rest.map(function (node) {
            return h(SessionCard, {
              key: node.id,
              node: node,
              t: t,
              now: now,
              showWorkspace: true,
              onOpen: props.onOpen,
              onTogglePin: toggleSessionPin,
            });
          })));
        body = flatParts;
      }

      // A damaged pin file or a rejected write must be visible: a pin the user
      // believes in but the file does not hold is the failure this hides worst.
      var notice = null;
      if (pins.corrupt === true) {
        notice = h('div', { className: 'sessionPanel__notice', role: 'alert' }, [
          h('span', { key: 't', className: 'sessionPanel__noticeText' }, t('pin.corrupt', { file: '~/.dsh/plugin-data/dsh-session-panel.json' })),
          h('button', {
            key: 'r',
            type: 'button',
            className: 'sessionPanel__noticeAction',
            onClick: function () { props.pinClient.retry(); },
          }, t('pin.retry')),
        ]);
      } else if (pins.error !== null) {
        notice = h('div', { className: 'sessionPanel__notice', role: 'alert' },
          h('span', { key: 't', className: 'sessionPanel__noticeText' },
            t('pin.failed') + '：' + pins.error));
      }

      return h('div', { className: 'sessionPanel' }, [
        h(StyleSheet, { key: 'style' }),
        h('div', { key: 'head', className: 'sessionPanel__head' }, [
          h('div', { key: 'titles', className: 'sessionPanel__titles' }, [
            h('h1', { key: 'h1', className: 'sessionPanel__title' }, t('page.title')),
            h('p', { key: 'p', className: 'sessionPanel__subtitle' },
              mode === MODE_WORKSPACE ? t('page.subtitle.workspace') : t('page.subtitle.flat')),
          ]),
          h('div', { key: 'actions', className: 'sessionPanel__actions' }, [
            h(ModeSwitch, {
              key: 'mode',
              t: t,
              mode: mode,
              onChange: changeMode,
            }),
            h('button', {
              key: 'archived',
              type: 'button',
              className: 'sessionPanel__toggle'
                + (showArchived ? ' sessionPanel__toggle--on' : ''),
              'aria-pressed': showArchived ? 'true' : 'false',
              onClick: function () { setShowArchived(!showArchived); },
            }, showArchived ? t('page.hideArchived') : t('page.showArchived')),
          ]),
        ]),
        h('div', { key: 'count', className: 'sessionPanel__count' }, countText),
        notice,
        h('div', { key: 'body', className: 'sessionPanel__body' }, body),
      ]);
    }

    // =========================================================================
    // 5. Styles
    // =========================================================================

    /**
     * Component-local stylesheet.
     *
     * Rendered as an element so unmounting removes it — no global stylesheet is
     * left behind. Every colour is a `--dsw-*` theme token, so light and dark
     * both read correctly; the pin accent is the one exception, and it carries a
     * dark-theme override.
     */
    function StyleSheet() {
      return h('style', null, `
.sessionPanel {
  height: 100%;
  overflow-y: auto;
  padding: 24px 24px 48px;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  /* The pin accent is the one colour the theme tokens cannot express: the
     palette has no "soft blue chip". Light and dark each get their own pair so
     the glyph keeps 6.5:1 against its own background in both. */
  --sessionPanel-pin-bg: #dceafd;
  --sessionPanel-pin-fg: #1b4f9c;
}
@media (prefers-color-scheme: dark) {
  .sessionPanel {
    --sessionPanel-pin-bg: rgba(75, 130, 210, .30);
    --sessionPanel-pin-fg: #a9c9f5;
  }
}
.sessionPanel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.sessionPanel__titles { min-width: 0; }
.sessionPanel__title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.sessionPanel__subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.sessionPanel__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sessionPanel__count {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-caption);
  margin-bottom: 16px;
}

/* ---- mode switch: the selected half is blue with white text ---- */
.sessionPanel__segmented {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-skeleton);
}
.sessionPanel__segmentedItem {
  appearance: none;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 4px 12px;
  border-radius: calc(var(--dsw-radius-sm) - 2px);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color .12s ease, color .12s ease;
}
.sessionPanel__segmentedItem:hover { color: var(--dsw-alias-label-primary); }
.sessionPanel__segmentedItem--on,
.sessionPanel__segmentedItem--on:hover {
  background: #2f6fd0;
  color: #fff;
  font-weight: 600;
}
.sessionPanel__segmentedItem:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: 1px;
}

.sessionPanel__toggle {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l4);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 4px 10px;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
}
.sessionPanel__toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.sessionPanel__toggle--on {
  color: var(--dsw-alias-link);
  border-color: var(--dsw-alias-link);
}
.sessionPanel__toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: 1px;
}

/* ---- notice: a refused or damaged pin write ---- */
.sessionPanel__notice {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  border: 1px solid var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
.sessionPanel__noticeText { flex: 1 1 auto; overflow-wrap: anywhere; }
.sessionPanel__noticeAction {
  appearance: none;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
}

.sessionPanel__body { display: flex; flex-direction: column; gap: 20px; }

/* ---- workspace sections ---- */
.sessionPanel__group { display: flex; flex-direction: column; gap: 6px; }
.sessionPanel__groupHead { display: flex; align-items: center; gap: 8px; }
.sessionPanel__groupName {
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.sessionPanel__groupCount {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-caption);
  background: var(--dsw-alias-bg-skeleton);
  border-radius: var(--dsw-radius-xs);
  padding: 0 6px;
}
.sessionPanel__groupPath {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-caption);
  overflow-wrap: anywhere;
}

/* ---- the workspace pin button ---- */
.sessionPanel__wsPin {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.sessionPanel__wsPin:hover {
  background: var(--dsw-alias-bg-skeleton);
  color: #2f6fd0;
}
.sessionPanel__wsPin--on {
  background: var(--sessionPanel-pin-bg);
  color: var(--sessionPanel-pin-fg);
  font-weight: 600;
}
.sessionPanel__wsPinGlyph { display: flex; align-items: center; }
.sessionPanel__wsPin:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: 1px;
}

/* ---- cards ---- */
.sessionPanel__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}
.sessionPanel__flatList { display: flex; flex-direction: column; gap: 6px; }

.sessionPanel__card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  text-align: left;
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.sessionPanel__card:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sessionPanel__card:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: 1px;
}
/* A pinned card gets a soft left bar rather than a full blue border: it reads
   as a marker without competing with the hover fill. */
.sessionPanel__card--pinned::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2.5px;
  border-radius: 2px;
  background: var(--sessionPanel-pin-fg);
  opacity: .45;
}
.sessionPanel__card--archived { opacity: .55; cursor: default; }
.sessionPanel__cardDot { display: flex; align-items: center; height: 20px; flex: none; }
.sessionPanel__cardBody {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
  /* Leave room for the pin button so it never overlaps the timestamp. */
  padding-right: 26px;
}
.sessionPanel__cardTitle {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sessionPanel__cardMeta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  min-width: 0;
}
.sessionPanel__cardStatus { color: var(--dsw-alias-label-secondary); flex: none; }
.sessionPanel__cardTime { margin-left: auto; flex: none; }
/* The workspace tag: a pill, so it reads as a classification rather than as
   part of the status sentence. Truncates instead of breaking the card. */
.sessionPanel__cardWs {
  background: var(--dsw-alias-bg-skeleton);
  border-radius: 999px;
  padding: 0 7px;
  font-size: 10px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: none;
}

/* ---- the card pin button ---- */
.sessionPanel__pin {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  padding: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
  opacity: 0;
  transition: opacity .12s ease, background-color .12s ease, color .12s ease;
}
.sessionPanel__card:hover .sessionPanel__pin { opacity: 1; }
.sessionPanel__pin:hover {
  background: var(--dsw-alias-bg-skeleton);
  color: var(--dsw-alias-label-primary);
}
.sessionPanel__pin--on,
.sessionPanel__pin--locked {
  opacity: 1;
  background: var(--sessionPanel-pin-bg);
  color: var(--sessionPanel-pin-fg);
}
.sessionPanel__pin--locked { cursor: default; }
.sessionPanel__pin:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: 1px;
  opacity: 1;
}

/* ---- status dots ---- */
.sessionPanel__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex: none;
  background: var(--dsw-alias-label-dimmed);
}
.sessionPanel__dot--running { background: var(--dsw-alias-state-business-primary); }
.sessionPanel__dot--approval,
.sessionPanel__dot--planReview,
.sessionPanel__dot--question { background: var(--dsw-alias-state-error-primary); }
.sessionPanel__dot--done { background: var(--dsw-alias-state-business-primary); opacity: .5; }
.sessionPanel__dot--idle { background: var(--dsw-alias-label-dimmed); }

/* ---- section label and the rule that follows it ---- */
.sessionPanel__sectionLabel {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 600;
  letter-spacing: .03em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-caption);
  margin-bottom: 8px;
}
.sessionPanel__sectionGlyph { display: flex; align-items: center; color: var(--sessionPanel-pin-fg); }
.sessionPanel__rule {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 0;
}
.sessionPanel__ruleLine {
  flex: 1;
  height: 1px;
  background: var(--dsw-alias-border-l4);
}
.sessionPanel__ruleText {
  font-size: 11px;
  line-height: 16px;
  font-weight: 600;
  letter-spacing: .03em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-caption);
  white-space: nowrap;
}

.sessionPanel__more {
  appearance: none;
  align-self: flex-start;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-link);
  padding: 2px 0;
  cursor: pointer;
}
.sessionPanel__more:hover { text-decoration: underline; }
.sessionPanel__empty {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  padding: 32px 0;
}
`);
    }

    /** Sidebar row glyph: a board of stacked panels. */
    function PanelIcon(props) {
      var size = typeof props.size === 'number' && props.size > 0 ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': 'true',
        style: { display: 'block' },
      }, [
        h('rect', {
          key: 'a', x: 2, y: 2.5, width: 12, height: 3.2, rx: 1,
          stroke: 'currentColor', strokeWidth: 1.2,
        }),
        h('rect', {
          key: 'b', x: 2, y: 7.4, width: 5.2, height: 6.1, rx: 1,
          stroke: 'currentColor', strokeWidth: 1.2,
        }),
        h('rect', {
          key: 'c', x: 8.8, y: 7.4, width: 5.2, height: 6.1, rx: 1,
          stroke: 'currentColor', strokeWidth: 1.2,
        }),
      ]);
    }

    // =========================================================================
    // 6. apply
    // =========================================================================

    /** Panel id: the sidebar list id and the matching `main` key. */
    const PANEL_ID = 'session-panel';

    /**
     * Row order. The shipped rows are Plugins at 0 and Automation tasks at 10,
     * so 11 places this row directly below Automation tasks.
     */
    const PANEL_ORDER = 11;

    /** `ctx.get` never throws for an absent service; `ctx.locale` may not exist. */
    function readLocale(ctx) {
      if (ctx === null || typeof ctx !== 'object') return undefined;
      try {
        if (typeof ctx.get === 'function') {
          var viaGet = ctx.get('locale');
          if (viaGet !== undefined && viaGet !== null) return viaGet;
        }
      } catch {
        /* fall through to the property */
      }
      try {
        if (ctx.locale !== undefined && ctx.locale !== null) return ctx.locale;
      } catch {
        /* no locale service at all */
      }
      return undefined;
    }

    /**
     * `slots` and `uiWorkspace` are hard dependencies: without the first there is
     * nowhere to register, and without the second a card click could not navigate.
     * `locale` is read through `ctx.get`, so a composition without it degrades to
     * the inline table instead of failing to activate.
     */
    exports.inject = ['slots', 'uiWorkspace'];

    exports.apply = function apply(ctx) {
      try {
        var locale = readLocale(ctx);
        var t = createTranslator(locale);

        // One pin client for the whole plugin: both modes read the same set, and
        // the initial load happens once rather than per mount.
        var pinClient = createPinClient();
        pinClient.load();
        ctx.effect(function () {
          return function () { /* no timers or listeners to release */ };
        }, 'session-panel: pin client');

        if (locale !== undefined && typeof locale.register === 'function') {
          try {
            var disposer = locale.register(DICT_NS, { zh: DICT.zh, en: DICT.en });
            ctx.effect(function () {
              return function () {
                try {
                  if (typeof disposer === 'function') disposer();
                } catch {
                  /* nothing left to release */
                }
              };
            }, 'session-panel: dictionaries');
          } catch (error) {
            // A taken namespace (a reload) must not cost the page: the inline
            // table answers every key either way.
            console.error('session-panel: 注册文案字典失败，改用内置文案', error);
          }
        }

        /** Navigate to a Session; failures are logged, never thrown at the user. */
        function openSession(sessionId) {
          try {
            ctx.uiWorkspace.openSession(sessionId);
          } catch (error) {
            console.error('session-panel: 打开会话失败', error);
          }
        }

        /**
         * Toggle a Session pin through the Harness's own API.
         *
         * The Harness owns this state (`pinnedSessionIds`), so the panel never
         * keeps a second copy: a pin made in the sidebar shows up here and the
         * other way round.
         */
        function toggleSessionPin(sessionId, pinned) {
          try {
            var result = pinned
              ? ctx.uiWorkspace.pinSession(sessionId)
              : ctx.uiWorkspace.unpinSession(sessionId);
            if (result !== undefined && typeof result.catch === 'function') {
              result.catch(function (error) {
                console.error('session-panel: 会话置顶没能保存', error);
              });
            }
          } catch (error) {
            console.error('session-panel: 会话置顶失败', error);
          }
        }

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function () { return t('panel'); },
          }, PanelIcon);
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: function () {
              return {
                t: t,
                pinClient: pinClient,
                onOpen: openSession,
                onToggleSessionPin: toggleSessionPin,
                onToggleWorkspacePin: function (path, pinned) {
                  pinClient.set(path, pinned);
                },
              };
            },
          }, SessionPanelPage);
        });
      } catch (error) {
        // A broken panel must not take down the host half or the rest of the
        // client: surface it and stop.
        console.error('session-panel: 注册会话面板失败', error);
      }
    };

    return module.exports;
  },
});

import * as vscode from 'vscode';
import { SearchService, SearchItem, SearchResult, TabId, GroupCount } from '../search/searchService';

/**
 * Search Everywhere 를 VS Code 기본 QuickPick 목록으로 여는 방식 (설정 ui = "quickPick").
 * 코드 위에 바로 뜨지만 화면 구성은 VS Code 목록 그대로다.
 */

/** 탭 정의: 모두 / 클래스 / 파일 / 심볼 / Mapper / 액션 / 텍스트 */
const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'all', label: '모두', icon: 'search' },
  { id: 'classes', label: '클래스', icon: 'symbol-class' },
  { id: 'files', label: '파일', icon: 'file' },
  { id: 'symbols', label: '심볼', icon: 'symbol-method' },
  { id: 'mappers', label: 'Mapper', icon: 'database' },
  { id: 'spring', label: 'Spring', icon: 'symbol-namespace' },
  { id: 'actions', label: '액션', icon: 'zap' },
  { id: 'text', label: '텍스트', icon: 'whole-word' },
];

/** QuickPick 항목에 우리 검색 결과를 같이 들고 다니기 위한 확장 타입 */
interface PickItem extends vscode.QuickPickItem {
  data?: SearchItem;
  /** "더 보기" 항목: 그 종류를 더 보여 준다 */
  more?: SearchItem['kind'];
}

class TabButton implements vscode.QuickInputButton {
  constructor(
    public readonly tab: TabId,
    public readonly iconPath: vscode.ThemeIcon,
    public readonly tooltip: string
  ) {}
}

/** "라이브러리 포함" 토글 버튼 */
class NonProjectToggle implements vscode.QuickInputButton {
  constructor(public readonly on: boolean) {}
  get iconPath() {
    return new vscode.ThemeIcon(this.on ? 'library' : 'root-folder');
  }
  get tooltip() {
    return this.on ? '라이브러리 포함: 켜짐' : '라이브러리 포함: 꺼짐 (프로젝트, 테스트 제외)';
  }
}

export function openQuickPick(service: SearchService, initialTab: TabId) {
  const qp = vscode.window.createQuickPick<PickItem>();
  let currentTab: TabId = initialTab;
  let runId = 0; // 오래된 검색 결과가 늦게 도착해도 무시하기 위한 토큰
  let debounce: NodeJS.Timeout | undefined;
  let limit: number | undefined; // "더 보기"로 늘린 표시 개수 (검색어·탭이 바뀌면 초기화)
  let lastGroups: GroupCount[] = []; // 지금 화면에 그린 결과의 개수 (partial 포함)
  let keepAfterMore: SearchItem | undefined; // "더 보기"를 누르기 직전에 보던 결과
  qp.matchOnDescription = false;
  // 우리가 정한 순서(점수·우선순위, 종류별 "더 보기" 위치)를 VS Code 가 라벨 일치도로 다시 섞지 않게
  (qp as { sortByLabel?: boolean }).sortByLabel = false;
  qp.matchOnDetail = false;
  qp.placeholder = '검색어 입력 · 탭 전환: 오른쪽 위 아이콘 또는 접두어 c/ f/ s/ m/ b/ a/ t/';
  const updateButtons = () => {
    qp.buttons = [
      ...TABS.map((t) => new TabButton(t.id, new vscode.ThemeIcon(t.icon), t.label)),
      new NonProjectToggle(service.includeNonProject),
    ];
  };

  const updateTitle = () => {
    const tabs = TABS.map((t) => (t.id === currentTab ? `[${t.label}]` : t.label)).join('   ');
    const p = service.options.paths;
    const filter = p.include || p.exclude ? `   · 필터: ${p.include || '전체'}${p.exclude ? ' − ' + p.exclude : ''}` : '';
    qp.title = (service.includeNonProject ? `${tabs}   · 라이브러리 포함` : tabs) + filter;
  };
  updateButtons();

  const run = async () => {
    const myRun = ++runId;
    let text = qp.value;

    // 접두어로 탭 전환: "c/Foo" → 클래스 탭에서 Foo 검색
    const prefix = /^([cfsmbat])\/(.*)$/.exec(text);
    let tab = currentTab;
    if (prefix) {
      tab = (
        { c: 'classes', f: 'files', s: 'symbols', m: 'mappers', b: 'spring', a: 'actions', t: 'text' } as Record<string, TabId>
      )[prefix[1]];
      text = prefix[2];
    }

    qp.busy = true;
    try {
      const keep = keepAfterMore;
      keepAfterMore = undefined;
      const r = await service.searchTimed(tab, text, () => myRun !== runId, limit, (p) => {
        if (myRun !== runId) return;
        lastGroups = p.groups;
        qp.items = toPickItems(tab, p.items, p.groups); // 텍스트는 뒤에 붙는다
      });
      if (myRun !== runId) {
        return; // 더 최신 검색이 시작됨
      }
      const shown = r;
      lastGroups = shown.groups;
      qp.items = toPickItems(tab, shown.items, shown.groups);
      // 메서드·필드 색인이 아직 만들어지는 중이면 다 되는 대로 다시 검색
      if (r.indexIncomplete) {
        void service.whenIndexComplete().then(() => {
          if (myRun === runId) void run();
        });
      }
      // "더 보기" 뒤에는 보던 항목 근처에 머문다
      if (keep && limit) {
        const same = qp.items.find((i) => i.data && i.data.uri?.toString() === keep.uri?.toString() && i.data.label === keep.label);
        if (same) qp.activeItems = [same];
      }
    } catch (e) {
      console.error('[SearchEverywhere]', e);
    } finally {
      if (myRun === runId) {
        qp.busy = false;
      }
    }
  };

  const schedule = () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(run, 120);
  };

  qp.onDidChangeValue(() => {
    limit = undefined;
    schedule();
  });

  qp.onDidTriggerButton((b) => {
    if (b instanceof TabButton) {
      currentTab = b.tab;
      limit = undefined;
      updateTitle();
      run();
    } else if (b instanceof NonProjectToggle) {
      service.includeNonProject = !service.includeNonProject;
      limit = undefined;
      updateButtons();
      updateTitle();
      run();
    }
  });

  qp.onDidAccept(async () => {
    const picked = qp.selectedItems[0];
    if (picked?.more) {
      if (currentTab === 'all' && !/^[cfsat]\//.test(qp.value)) {
        currentTab = picked.more; // 모두 탭: 그 종류의 탭으로
        limit = undefined;
        updateTitle();
      } else {
        const g = lastGroups.find((x) => x.kind === picked.more);
        const shown = g?.shown ?? qp.items.filter((i) => i.data).length;
        limit = shown + vscode.workspace.getConfiguration('devBoost.searchEverywhere').get<number>('maxResults', 50);
        // 더 불러온 뒤 이어서 볼 수 있게 마지막 결과 위치를 기억
        keepAfterMore = [...qp.items].reverse().find((i) => i.data)?.data;
      }
      void run();
      return;
    }
    if (!picked?.data) {
      return;
    }
    qp.hide();
    await service.open(picked.data);
  });

  qp.onDidHide(() => {
    if (debounce) {
      clearTimeout(debounce);
    }
    runId++; // 진행 중이던 검색 무효화 (rg 는 25ms 안에 멈춤)
    service.logLine('[검색] 창 닫힘 → 진행 중 검색 중단');
    qp.dispose();
  });

  updateTitle();
  service.warmUp(); // 입력하는 동안 색인·파일 목록을 미리 만든다
  qp.show();
  run();
}

/** 검색 결과를 QuickPick 항목으로 변환. '모두' 탭은 종류별 구분선을 넣는다. */

function toPickItems(tab: TabId, results: SearchItem[], groups: GroupCount[] = []): PickItem[] {
  const items: PickItem[] = [];
  let lastKind: string | undefined;
  const fmt = (n: number) => n.toLocaleString('ko-KR');
  const moreItem = (kind: SearchItem['kind']) => {
    const g = groups.find((x) => x.kind === kind);
    if (!g || !(g.total > g.shown || (g.capped && tab === 'all'))) return;
    const total = g.capped ? `${fmt(g.total)}건 이상` : `${fmt(g.total)}개`;
    items.push({
      label: tab === 'all' ? `$(ellipsis) ${kindLabel(kind)} 더 보기` : '$(ellipsis) 더 보기',
      description: `${total} 중 ${fmt(g.shown)}개 표시`,
      alwaysShow: true,
      more: kind,
    });
  };

  results.forEach((r, i) => {
    if (tab === 'all' && r.kind !== lastKind) {
      items.push({ label: kindLabel(r.kind), kind: vscode.QuickPickItemKind.Separator });
      lastKind = r.kind;
    }
    items.push({
      label: `$(${r.icon}) ${r.label}`,
      description: r.description,
      detail: r.detail,
      // 우리가 이미 검색한 결과이므로 QuickPick의 자체 필터로 숨기지 않게 한다
      // (접두어 "t/..." 나 중간 글자 매치가 사라지는 문제 방지)
      alwaysShow: true,
      data: r,
    });
    if (results[i + 1]?.kind !== r.kind) moreItem(r.kind);
  });
  return items;
}

function kindLabel(kind: SearchItem['kind']): string {
  switch (kind) {
    case 'classes':
      return '클래스';
    case 'files':
      return '파일';
    case 'symbols':
      return '심볼';
    case 'mappers':
      return 'Mapper';
    case 'spring':
      return 'Spring';
    case 'actions':
      return '액션';
    case 'text':
      return '텍스트';
    default:
      return kind;
  }
}

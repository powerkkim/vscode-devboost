import * as vscode from 'vscode';
import { SearchService, SearchItem, TabId } from './searchService';
import { Feature } from '../feature';

/** 탭 정의: IntelliJ의 "모두/클래스/파일/심볼/액션/텍스트" 와 동일한 순서 */
const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'all', label: '모두', icon: 'search' },
  { id: 'classes', label: '클래스', icon: 'symbol-class' },
  { id: 'files', label: '파일', icon: 'file' },
  { id: 'symbols', label: '심볼', icon: 'symbol-method' },
  { id: 'actions', label: '액션', icon: 'zap' },
  { id: 'text', label: '텍스트', icon: 'whole-word' },
];

/** QuickPick 항목에 우리 검색 결과를 같이 들고 다니기 위한 확장 타입 */
interface PickItem extends vscode.QuickPickItem {
  data?: SearchItem;
}

class TabButton implements vscode.QuickInputButton {
  constructor(
    public readonly tab: TabId,
    public readonly iconPath: vscode.ThemeIcon,
    public readonly tooltip: string
  ) {}
}

/** "비 프로젝트 항목 포함" 토글 버튼 */
class NonProjectToggle implements vscode.QuickInputButton {
  constructor(public readonly on: boolean) {}
  get iconPath() {
    return new vscode.ThemeIcon(this.on ? 'library' : 'root-folder');
  }
  get tooltip() {
    return this.on ? '비 프로젝트 항목 포함: 켜짐 (.m2, JDK 포함)' : '비 프로젝트 항목 포함: 꺼짐 (프로젝트만)';
  }
}

/**
 * Search Everywhere 기능.
 * start()가 돌려준 Disposable들을 dispose하면 커맨드 등록·파일 감시가 모두 해제된다 (기능 OFF).
 */
export const searchEverywhere: Feature = {
  id: 'searchEverywhere',
  name: 'Search Everywhere',
  start(context) {
    const service = new SearchService(context);
    const cmd = (command: string, tab: TabId) =>
      vscode.commands.registerCommand(`devBoost.searchEverywhere.${command}`, () =>
        openSearch(service, tab)
      );
    return [
      cmd('open', 'all'),
      cmd('classes', 'classes'),
      cmd('files', 'files'),
      cmd('symbols', 'symbols'),
      cmd('actions', 'actions'),
      cmd('text', 'text'),
      service,
    ];
  },
};

function openSearch(service: SearchService, initialTab: TabId) {
  const qp = vscode.window.createQuickPick<PickItem>();
  let currentTab: TabId = initialTab;
  let runId = 0; // 오래된 검색 결과가 늦게 도착해도 무시하기 위한 토큰
  let debounce: NodeJS.Timeout | undefined;

  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.placeholder = '검색어 입력 · 탭 전환: 오른쪽 위 아이콘 또는 접두어 c/ f/ s/ a/ t/';
  const updateButtons = () => {
    qp.buttons = [
      ...TABS.map((t) => new TabButton(t.id, new vscode.ThemeIcon(t.icon), t.label)),
      new NonProjectToggle(service.includeNonProject),
    ];
  };

  const updateTitle = () => {
    const tabs = TABS.map((t) => (t.id === currentTab ? `[${t.label}]` : t.label)).join('   ');
    qp.title = service.includeNonProject ? `${tabs}   · 비 프로젝트 포함` : tabs;
  };
  updateButtons();

  const run = async () => {
    const myRun = ++runId;
    let text = qp.value;

    // 접두어로 탭 전환: "c/Foo" → 클래스 탭에서 Foo 검색
    const prefix = /^([cfsat])\/(.*)$/.exec(text);
    let tab = currentTab;
    if (prefix) {
      tab = (
        { c: 'classes', f: 'files', s: 'symbols', a: 'actions', t: 'text' } as Record<string, TabId>
      )[prefix[1]];
      text = prefix[2];
    }

    qp.busy = true;
    try {
      const results = await service.search(tab, text, () => myRun !== runId);
      if (myRun !== runId) {
        return; // 더 최신 검색이 시작됨
      }
      qp.items = toPickItems(tab, results);
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

  qp.onDidChangeValue(schedule);

  qp.onDidTriggerButton((b) => {
    if (b instanceof TabButton) {
      currentTab = b.tab;
      updateTitle();
      run();
    } else if (b instanceof NonProjectToggle) {
      service.includeNonProject = !service.includeNonProject;
      updateButtons();
      updateTitle();
      run();
    }
  });

  qp.onDidAccept(async () => {
    const picked = qp.selectedItems[0];
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
    runId++; // 진행 중이던 검색 무효화
    qp.dispose();
  });

  updateTitle();
  qp.show();
  run();
}

/** 검색 결과를 QuickPick 항목으로 변환. '모두' 탭은 종류별 구분선을 넣는다. */
function toPickItems(tab: TabId, results: SearchItem[]): PickItem[] {
  const items: PickItem[] = [];
  let lastKind: string | undefined;

  for (const r of results) {
    if (tab === 'all' && r.kind !== lastKind) {
      items.push({ label: kindLabel(r.kind), kind: vscode.QuickPickItemKind.Separator });
      lastKind = r.kind;
    }
    items.push({
      label: `$(${r.icon}) ${r.label}`,
      description: r.description,
      detail: r.detail,
      // 우리가 이미 검색한 결과이므로 QuickPick의 자체 필터로 숨기지 않게 한다
      // (접두어 "t/..." 나 언어서버의 CamelCase 매치가 사라지는 문제 방지)
      alwaysShow: true,
      data: r,
    });
  }
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
    case 'actions':
      return '액션';
    case 'text':
      return '텍스트';
    default:
      return kind;
  }
}

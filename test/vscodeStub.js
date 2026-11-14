// 묶은 확장(dist/extension.js)을 실제 VS Code 없이 켜 보기 위한 가짜 vscode 모듈.
// 필요한 것만 진짜처럼 만들고(설정·명령·출력 채널), 나머지는 무엇을 불러도 받아 주는 빈 껍데기로 채운다.
const Module = require('module');
const path = require('path');

/** 무엇을 읽어도·불러도·new 해도 되는 값 (class … extends 도 된다) */
function anything() {
  const f = function () {};
  return new Proxy(f, {
    get: (t, k) => (k === 'prototype' ? t.prototype : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : typeof k === 'symbol' ? undefined : anything()),
    apply: () => anything(),
    construct: () => ({ dispose() {} }),
  });
}

function createVscodeStub(root) {
  const pkg = require(path.join(root, 'package.json'));
  const defaults = {};
  for (const sec of [].concat(pkg.contributes.configuration)) for (const [k, v] of Object.entries(sec.properties)) defaults[k] = v.default;
  const state = { commands: new Map(), errors: [], warnings: [], output: [], settings: {} };
  const disposable = () => ({ dispose() {} });
  const event = () => disposable();
  class Uri {
    constructor(fsPath) {
      this.fsPath = fsPath;
      this.scheme = 'file';
      this.path = fsPath.replace(/\\/g, '/');
    }
    static file(p) {
      return new Uri(p);
    }
    static joinPath(base, ...segs) {
      return new Uri(path.join(base.fsPath, ...segs));
    }
    static parse(s) {
      return new Uri(String(s).replace(/^file:\/\//, ''));
    }
    toString() {
      return 'file://' + this.path;
    }
  }
  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (fn) => (this.listeners.add(fn), { dispose: () => this.listeners.delete(fn) });
    }
    fire(e) {
      for (const fn of [...this.listeners]) fn(e);
    }
    dispose() {
      this.listeners.clear();
    }
  }
  class Disposable {
    constructor(fn) {
      this.dispose = fn ?? (() => {});
    }
    static from(...items) {
      return new Disposable(() => items.forEach((d) => d.dispose()));
    }
  }
  class MarkdownString {
    constructor(value = '') {
      this.value = value;
    }
    appendMarkdown(t) {
      this.value += t;
      return this;
    }
    appendText(t) {
      this.value += t;
      return this;
    }
  }
  const explicit = {
    Uri,
    MarkdownString,
    EventEmitter,
    Disposable,
    workspace: {
      workspaceFolders: undefined,
      textDocuments: [],
      getConfiguration: (section) => ({
        get: (key, dflt) => {
          const full = section ? `${section}.${key}` : key;
          return full in state.settings ? state.settings[full] : full in defaults ? defaults[full] : dflt;
        },
        inspect: () => undefined,
        update: async () => undefined,
      }),
      getWorkspaceFolder: () => undefined,
      asRelativePath: (u) => (typeof u === 'string' ? u : u.fsPath),
      createFileSystemWatcher: () => ({ onDidCreate: event, onDidChange: event, onDidDelete: event, dispose() {} }),
      findFiles: async () => [],
      onDidChangeConfiguration: event,
      onDidChangeWorkspaceFolders: event,
      onDidChangeTextDocument: event,
      onDidOpenTextDocument: event,
      onDidCloseTextDocument: event,
      onDidSaveTextDocument: event,
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      terminals: [],
      tabGroups: { all: [], onDidChangeTabs: event, onDidChangeTabGroups: event },
      showErrorMessage: (m) => (state.errors.push(String(m)), Promise.resolve(undefined)),
      showWarningMessage: (m) => (state.warnings.push(String(m)), Promise.resolve(undefined)),
      showInformationMessage: () => Promise.resolve(undefined),
      setStatusBarMessage: disposable,
      createOutputChannel: () => ({ appendLine: (l) => state.output.push(l), append: (l) => state.output.push(l), clear: () => (state.output.length = 0), show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      withProgress: (_o, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: event }),
      onDidChangeActiveTextEditor: event,
      onDidChangeVisibleTextEditors: event,
      onDidChangeTextEditorSelection: event,
      onDidStartTerminalShellExecution: event,
      onDidChangeWindowState: event,
    },
    commands: {
      registerCommand: (id, fn) => (state.commands.set(id, fn), { dispose: () => state.commands.delete(id) }),
      registerTextEditorCommand: (id, fn) => (state.commands.set(id, fn), { dispose: () => state.commands.delete(id) }),
      executeCommand: async () => undefined,
      getCommands: async () => [...state.commands.keys()],
    },
    extensions: { getExtension: () => undefined, onDidChange: event, all: [] },
    env: { appRoot: '/nonexistent', clipboard: { writeText: async () => {}, readText: async () => '' }, language: 'ko' },
  };
  const fallback = (obj) => new Proxy(obj, { get: (t, k) => (k in t ? t[k] : typeof k === 'symbol' ? undefined : anything()) });
  const vscode = fallback({ ...explicit, workspace: fallback(explicit.workspace), window: fallback(explicit.window), commands: fallback(explicit.commands), env: fallback(explicit.env) });
  // 묶은 코드는 모듈의 "자기 속성"만 복사해 쓰고 나머지는 프로토타입에서 찾는다 → 가짜를 프로토타입 자리에 둔다
  return { vscode: Object.create(vscode), state, Uri };
}

/** require('vscode') 가 가짜를 받도록 건다. 되돌리는 함수를 돌려준다 */
function installVscodeStub(vscode) {
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : orig.call(this, request, ...rest);
  };
  return () => (Module._load = orig);
}

module.exports = { createVscodeStub, installVscodeStub };

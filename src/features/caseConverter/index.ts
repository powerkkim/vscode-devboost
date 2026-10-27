import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { SchemaStore } from '../dbSchema/schemaStore';
import { CASES, CaseKind, convertText } from './convert/words';
import {
  DateType,
  SchemaLookup,
  renderJavaFields,
  sqlToJavaFields,
  statementAt,
} from './convert/sql';
import { MyBatisPart, TsOptions, javaToMyBatis, javaToTs, parseJavaFields } from './convert/java';

/**
 * 케이스 변환 — 이름 표기법(camel·Pascal·snake·kebab …) 바꾸기와, 개발 중 자주 하는 변환.
 *  · SQL(SELECT 목록·INSERT·CREATE TABLE·컬럼 이름·테이블 이름) → Java 필드
 *  · Java 필드 → TypeScript 인터페이스
 *  · Java 필드 → MyBatis SQL(SELECT·INSERT·UPDATE·resultMap)
 * DB 스키마 기능으로 스키마를 가져와 두면 컬럼 타입·설명을 그대로 씀. 없으면 이름으로 타입을 추정.
 */

type OutputMode = 'newDocument' | 'clipboard' | 'insertBelow';

function cfg() {
  return vscode.workspace.getConfiguration('devBoost.caseConverter');
}

/* ------------------------------------------------------------------ 입력 */

interface Input {
  text: string;
  /** 어디서 가져왔는지 (알림용) */
  from: string;
  /** mapper XML 전체 (include 풀기용) */
  fullXml?: string;
}

async function readInput(kind: 'sql' | 'java'): Promise<Input | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    const sel = editor.selection;
    const isXml = doc.languageId === 'xml' || doc.fileName.toLowerCase().endsWith('.xml');
    if (!sel.isEmpty) {
      return { text: doc.getText(sel), from: '선택 영역', fullXml: isXml ? doc.getText() : undefined };
    }
    if (kind === 'sql' && isXml) {
      const st = statementAt(doc.getText(), doc.offsetAt(sel.active));
      if (st) {
        return { text: st.body, from: st.id ? `커서 위치 쿼리(${st.id})` : '커서 위치 쿼리', fullXml: doc.getText() };
      }
    }
    if ((kind === 'sql' && doc.languageId === 'sql') || (kind === 'java' && ['java', 'kotlin'].includes(doc.languageId))) {
      return { text: doc.getText(), from: '현재 파일' };
    }
  }
  const clip = (await vscode.env.clipboard.readText()).trim();
  if (clip) return { text: clip, from: '클립보드' };
  vscode.window.showWarningMessage(
    kind === 'sql'
      ? '변환할 내용이 없습니다. SQL·컬럼 이름·테이블 이름을 선택하거나, mapper XML 의 쿼리 안에 커서를 두거나, 복사해 두세요.'
      : '변환할 내용이 없습니다. Java 필드나 클래스를 선택하거나 복사해 두세요.'
  );
  return undefined;
}

/* ------------------------------------------------------------------ 출력 */

async function deliver(text: string, language: string, editor: vscode.TextEditor | undefined) {
  const mode = cfg().get<OutputMode>('output', 'newDocument');
  if (mode === 'clipboard') {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('변환 결과를 클립보드에 복사했습니다', 3000);
    return;
  }
  if (mode === 'insertBelow' && editor) {
    const end = editor.selection.isEmpty ? editor.selection.active.line : editor.selection.end.line;
    const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const pos = new vscode.Position(end, editor.document.lineAt(end).text.length);
    await editor.edit((b) => b.insert(pos, eol + eol + text.replace(/\n/g, eol)));
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ content: text, language });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  const pick = await vscode.window.showInformationMessage('변환 결과를 새 문서로 열었습니다.', '복사');
  if (pick === '복사') await vscode.env.clipboard.writeText(text);
}

function notifyWarnings(warnings: string[]) {
  if (warnings.length === 0) return;
  const shown = warnings.slice(0, 5).join('\n');
  vscode.window.showWarningMessage(warnings.length > 5 ? `${shown}\n… 외 ${warnings.length - 5}건` : shown);
}

/* ------------------------------------------------------------------ 스키마 연결 */

/** DB 스키마 기능으로 가져온 .devboost/schema/*.json 에서 컬럼 타입을 찾는다. 없으면 undefined */
async function loadLookup(store: SchemaStore): Promise<SchemaLookup | undefined> {
  store.pinRoot();
  const files = await store.list().catch(() => []);
  if (files.length === 0) return undefined;
  type Col = { name: string; typeText: string; comment?: string; position: number };
  const byTable = new Map<string, Col[]>();
  for (const info of files) {
    const s = await store.read(info.file);
    if (!s) continue;
    for (const c of s.columns) {
      const key = c.table.toUpperCase();
      // 같은 테이블이 여러 스키마(환경)에 있으면 먼저 읽은 것을 씀
      const list = byTable.get(key) ?? [];
      if (!list.some((x) => x.name.toUpperCase() === c.name.toUpperCase())) {
        list.push({ name: c.name, typeText: c.typeText || c.rawType, comment: c.comment, position: c.position });
      }
      byTable.set(key, list);
    }
  }
  if (byTable.size === 0) return undefined;
  return {
    column: (table, column) => byTable.get(table.toUpperCase())?.find((c) => c.name.toUpperCase() === column.toUpperCase()),
    columns: (table) => {
      const l = byTable.get(table.toUpperCase());
      return l && [...l].sort((a, b) => a.position - b.position);
    },
  };
}

/* ------------------------------------------------------------------ 명령 */

async function convertCase() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;

  // 선택이 없으면 커서 아래 단어
  const ranges = editor.selections.map((s) =>
    s.isEmpty ? doc.getWordRangeAtPosition(s.active, /[\p{L}\p{N}_$]+(?:-[\p{L}\p{N}_$]+)*/u) : s
  );
  const targets = ranges.filter((r): r is vscode.Range => !!r && !r.isEmpty);
  if (targets.length === 0) {
    vscode.window.showInformationMessage('바꿀 이름을 선택하거나 이름 위에 커서를 두세요.');
    return;
  }

  const sample = doc.getText(targets[0]);
  const items = CASES.map((c) => {
    const preview = convertText(sample.length > 60 ? sample.slice(0, 60) + '…' : sample, c.kind);
    return { label: c.label, description: preview === sample ? '(지금과 같음)' : preview, caseKind: c.kind as CaseKind };
  });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `케이스 선택 — ${targets.length}곳 변환`, matchOnDescription: true });
  if (!pick) return;

  await editor.edit((b) => {
    for (const r of targets) {
      const original = doc.getText(r);
      b.replace(r, convertText(original, pick.caseKind));
    }
  });
}

async function sqlToJava(store: SchemaStore) {
  const input = await readInput('sql');
  if (!input) return;
  const dateType = cfg().get<DateType>('java.dateType', 'LocalDateTime');
  const lookup = await loadLookup(store);
  const res = sqlToJavaFields(input.text, { dateType, lookup, fullXml: input.fullXml });
  if (res.fields.length === 0) {
    notifyWarnings(res.warnings.length ? res.warnings : ['변환할 컬럼을 찾지 못했습니다']);
    return;
  }
  const text = renderJavaFields(res.fields);
  await deliver(text, 'java', vscode.window.activeTextEditor);

  const notes: string[] = [...res.warnings];
  if (input.from === '클립보드') notes.unshift('선택 영역이 없어 클립보드 내용을 변환했습니다');
  if (res.fields.some((f) => f.guessed)) {
    notes.push(lookup ? '스키마에 없는 컬럼은 이름으로 타입을 추정했습니다' : '타입은 컬럼 이름으로 추정했습니다 — DB 스키마를 가져오면 실제 타입으로 바뀝니다');
  }
  if (res.imports.length) notes.push(`필요한 import: ${res.imports.join(', ')}`);
  notifyWarnings(notes);
}

function tsOptions(): TsOptions {
  const c = cfg();
  return {
    optional: c.get<TsOptions['optional']>('ts.optional', 'required'),
    dateType: c.get<TsOptions['dateType']>('ts.dateType', 'string'),
    objectType: c.get<TsOptions['objectType']>('ts.objectType', 'any'),
  };
}

async function askInterfaceName(suggested: string | undefined): Promise<string | undefined> {
  if (suggested) return suggested;
  return vscode.window.showInputBox({
    prompt: 'TypeScript 인터페이스 이름',
    value: 'Item',
    validateInput: (v) => (/^[A-Za-z_$][\w$]*$/.test(v) ? undefined : '영문·숫자·_ 로 된 이름'),
  });
}

async function javaToTypeScript() {
  const input = await readInput('java');
  if (!input) return;
  const cls = parseJavaFields(input.text);
  if (cls.fields.length === 0) {
    notifyWarnings(cls.warnings);
    return;
  }
  const name = await askInterfaceName(cls.name);
  if (!name) return;
  const res = javaToTs(cls, name, tsOptions());
  await deliver(res.text, 'typescript', vscode.window.activeTextEditor);
  const notes: string[] = [];
  if (input.from === '클립보드') notes.push('선택 영역이 없어 클립보드 내용을 변환했습니다');
  if (res.referenced.length) notes.push(`직접 만든 타입은 이름만 옮겼습니다 — 따로 변환하세요: ${res.referenced.join(', ')}`);
  notifyWarnings(notes);
}

async function javaToMyBatisSql() {
  const input = await readInput('java');
  if (!input) return;
  const cls = parseJavaFields(input.text);
  if (cls.fields.length === 0) {
    notifyWarnings(cls.warnings);
    return;
  }
  const picks = await vscode.window.showQuickPick(
    [
      { label: 'SELECT 컬럼', part: 'select' as MyBatisPart, picked: true },
      { label: 'INSERT', part: 'insert' as MyBatisPart, picked: true },
      { label: 'UPDATE', part: 'update' as MyBatisPart, picked: true },
      { label: 'resultMap', part: 'resultMap' as MyBatisPart, picked: false },
    ],
    { canPickMany: true, placeHolder: '만들 것을 고르세요' }
  );
  if (!picks || picks.length === 0) return;
  const c = cfg();
  const text = javaToMyBatis(
    cls,
    picks.map((p) => p.part),
    {
      columnCase: c.get<'lower' | 'upper'>('mybatis.columnCase', 'lower'),
      mapUnderscore: c.get<boolean>('mybatis.mapUnderscoreToCamelCase', true),
      tablePrefix: c.get<string>('mybatis.tablePrefix', ''),
      width: 100,
    }
  );
  await deliver(text, picks.length === 1 && picks[0].part === 'resultMap' ? 'xml' : 'sql', vscode.window.activeTextEditor);
  if (input.from === '클립보드') notifyWarnings(['선택 영역이 없어 클립보드 내용을 변환했습니다']);
}

export const caseConverter: Feature = {
  id: 'caseConverter',
  name: '케이스 변환',
  start() {
    const store = new SchemaStore();
    return [
      vscode.commands.registerCommand('devBoost.caseConverter.convertCase', () => convertCase()),
      vscode.commands.registerCommand('devBoost.caseConverter.sqlToJava', () => sqlToJava(store)),
      vscode.commands.registerCommand('devBoost.caseConverter.javaToTs', () => javaToTypeScript()),
      vscode.commands.registerCommand('devBoost.caseConverter.javaToMyBatis', () => javaToMyBatisSql()),
    ];
  },
};

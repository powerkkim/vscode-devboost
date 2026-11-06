import { randomUUID } from 'crypto';
import { DbConnectionConfig } from '../connection/config';
import { driverOf } from '../driver/registry';
import { ConnectionForm, emptyForm, formFromConfig, formToConfig, validateForm, fillFromHostInput, kindChoices, switchKind } from '../connection/form';

/** 팝업이 요청하는 일 (index.ts 가 채운다) */
export interface FormActions {
  /** 접속해 본다. password: 화면에 넣은 값, 비웠으면 undefined (저장된 것을 쓰라는 뜻). 결과를 한 줄로 돌려준다 */
  test(config: DbConnectionConfig, password: string | undefined): Promise<{ ok: boolean; message: string }>;
  /** 저장한다. password: 화면에 넣은 값, 비웠으면 undefined (저장된 것을 그대로) */
  save(config: DbConnectionConfig, password: string | undefined): Promise<void>;
}

/** 콘솔 화면(Webview) → 확장: 연결 팝업에서 오는 메시지 */
export type DialogMessage =
  | { type: 'dlgHostDone'; form: ConnectionForm }
  | { type: 'dlgDb'; form: ConnectionForm; from: ConnectionForm['kind'] }
  | { type: 'dlgPaste'; text: string; form: ConnectionForm }
  | { type: 'dlgTest'; form: ConnectionForm }
  | { type: 'dlgSave'; form: ConnectionForm }
  | { type: 'dlgCancel' };

/**
 * 연결 추가·수정 팝업 하나의 확장 쪽 상태 (팝업 자체는 콘솔 화면 안에 그려진다).
 * 값 확인·JDBC URL 풀기는 여기서(connection/form.ts) 한다. 저장된 비밀번호는 화면으로 보내지 않는다.
 * vscode 모듈에 의존하지 않는다
 */
export class FormDialog {
  readonly id: string;
  private testRun = 0;

  constructor(
    private readonly post: (msg: unknown) => void,
    private readonly actions: FormActions,
    private readonly existing?: DbConnectionConfig,
    private readonly hasSavedPassword = false
  ) {
    this.id = existing?.id ?? randomUUID();
  }

  /** 팝업을 연다 */
  open() {
    this.post({
      type: 'dialog',
      editing: !!this.existing,
      form: this.existing ? formFromConfig(this.existing) : emptyForm(),
      hasSavedPassword: this.hasSavedPassword,
      kinds: kindChoices(),
    });
  }

  /** 진행 중인 접속 테스트의 결과를 버린다 (팝업을 닫을 때) */
  cancel() {
    this.testRun++;
  }

  /**
   * 팝업에서 온 메시지를 처리한다.
   * 돌려주는 값: 'saved' = 저장하고 닫음(저장한 연결과 함께), 'cancelled' = 닫음, undefined = 계속 열려 있음
   */
  async onMessage(m: DialogMessage): Promise<{ done: 'saved'; config: DbConnectionConfig } | { done: 'cancelled' } | undefined> {
    switch (m.type) {
      case 'dlgHostDone': {
        // 호스트 칸에서 나갈 때: 한꺼번에 붙여 넣은 것이면 다른 칸에 나눠 채운다
        const filled = fillFromHostInput(m.form);
        if (filled) this.post({ type: 'dlgFill', form: filled });
        return undefined;
      }
      case 'dlgDb': {
        // DB 종류를 바꿨다: 기본 포트·접속 방식을 새 DB 에 맞춘다
        this.post({ type: 'dlgFill', form: switchKind({ ...m.form, kind: m.from }, m.form.kind ?? 'oracle') });
        return undefined;
      }
      case 'dlgPaste': {
        // "JDBC URL로 입력" 칸: 그 글을 호스트 칸에 넣은 것처럼 읽어 나눠 채운다
        const filled = fillFromHostInput({ ...m.form, host: m.text });
        if (filled) this.post({ type: 'dlgFill', form: filled, fromUrl: true });
        else this.post({ type: 'dlgUrlFailed', message: `읽지 못했습니다 (예: ${driverOf(m.form.kind).connect.jdbcExample})` });
        return undefined;
      }
      case 'dlgTest': {
        const form = fillFromHostInput(m.form) ?? m.form;
        // 테스트는 "비밀번호 저장" 여부와 관계없이 비밀번호만 있으면 된다 → 저장 관련 안내는 빼고 확인
        const errors = validateForm({ ...form, savePassword: false }, this.hasSavedPassword);
        this.post({ type: 'dlgErrors', errors });
        if (Object.keys(errors).length) return undefined;
        const run = ++this.testRun;
        this.post({ type: 'dlgTesting' });
        const r = await this.actions.test(formToConfig(form, this.id), form.password || undefined);
        if (run === this.testRun) this.post({ type: 'dlgTestResult', ...r });
        return undefined;
      }
      case 'dlgSave': {
        const form = fillFromHostInput(m.form) ?? m.form;
        const errors = validateForm(form, this.hasSavedPassword);
        this.post({ type: 'dlgErrors', errors });
        if (Object.keys(errors).length) return undefined;
        const config = formToConfig(form, this.id);
        await this.actions.save(config, form.password || undefined);
        this.cancel();
        this.post({ type: 'dlgClose' });
        return { done: 'saved', config };
      }
      case 'dlgCancel':
        this.cancel();
        return { done: 'cancelled' };
    }
  }
}

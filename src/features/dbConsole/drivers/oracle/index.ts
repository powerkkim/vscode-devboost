import type { DbDriver } from '../../driver/types';
import { oracleConnect } from './connect';
import { ORACLE_RULES } from './dialect';
import { oracleErrors } from './errors';
import { openOracle } from './session';

/** Oracle 드라이버 (node-oracledb Thin 모드, 12.1 이상) */
export const oracleDriver: DbDriver = {
  kind: 'oracle',
  label: 'Oracle',
  open: openOracle,
  rules: ORACLE_RULES,
  errors: oracleErrors,
  connect: oracleConnect,
};

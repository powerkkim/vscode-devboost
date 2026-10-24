import { parse, SFCDescriptor } from '@vue/compiler-sfc';

export interface ParsedSfc {
  descriptor: SFCDescriptor;
  errors: string[];
}

/** .vue 소스를 template / script / script setup 블록으로 분리한다. */
export function parseSfc(source: string, filename: string): ParsedSfc {
  const { descriptor, errors } = parse(source, { filename, sourceMap: false });
  return { descriptor, errors: errors.map((e) => String((e as Error).message ?? e)) };
}

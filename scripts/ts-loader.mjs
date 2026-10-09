// Standalone Node entrypoints (migrations and seeds): compile TypeORM decorators.
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const local = specifier.startsWith('@/')
      ? new URL(`../src/${specifier.slice(2)}`, import.meta.url)
      : specifier.startsWith('.') && context.parentURL
        ? new URL(specifier, context.parentURL) : null;
    if (local?.protocol === 'file:' && !existsSync(local)) {
      const source = new URL(`${local.href}.ts`);
      if (existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier.startsWith("@/") ? local.href : specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const source = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        fileName: fileURLToPath(url),
        compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
          experimentalDecorators: true,
        },
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

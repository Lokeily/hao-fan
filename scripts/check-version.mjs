import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lockJson = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const issueTemplate = await readFile(
  new URL('../.github/ISSUE_TEMPLATE/bug_report.yml', import.meta.url),
  'utf8',
);
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

const version = packageJson.version;
const values = [
  ['package-lock.json', lockJson.version],
  ['README.md', readme.match(/version-(\d+\.\d+\.\d+)-blue/)?.[1]],
  ['bug_report.yml', issueTemplate.match(/placeholder:.*v(\d+\.\d+\.\d+)/)?.[1]],
  ['CHANGELOG.md', changelog.match(/^## v(\d+\.\d+\.\d+)\b/m)?.[1]],
];
const mismatches = values.filter(([, value]) => value !== version);

if (mismatches.length > 0) {
  console.error(`Version metadata mismatch: expected ${version}`);
  for (const [file, value] of mismatches) console.error(`- ${file}: ${value ?? 'missing'}`);
  process.exit(1);
}

console.log(`Version metadata is consistent: ${version}`);

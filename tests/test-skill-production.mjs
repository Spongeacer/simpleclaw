/**
 * Skill Production Tests
 * Covers: security guards, metadata parsing, eligibility checks, hot-reload.
 */

import { mkdir, writeFile, rm, symlink, stat } from 'fs/promises';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

import {
  loadAllSkills,
  formatSkillList,
  evaluateSkillEligibility,
  hasBinary,
  DEFAULT_SECURITY_LIMITS,
} from '../dist/agent-runtime/skill/index.js';
import { SkillWatcher } from '../dist/agent-runtime/skill/skill-watcher.js';
import { isPathWithinRoot } from '../dist/agent-runtime/skill/skill-security.js';

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createSkillDir(baseDir, name, frontmatter, content = '# Skill\n') {
  const dir = join(baseDir, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${content}`);
  return dir;
}

// ─── Security Tests ──────────────────────────────────────────────────────────

async function testPathWithinRoot() {
  if (!isPathWithinRoot('/home/user/skills', '/home/user/skills/github')) {
    throw new Error('Expected child path to be within root');
  }
  if (isPathWithinRoot('/home/user/skills', '/home/user/other')) {
    throw new Error('Expected sibling path to be outside root');
  }
  if (isPathWithinRoot('/home/user/skills', '/home/user/skills/../escape')) {
    throw new Error('Expected escape path to be outside root');
  }
  console.log('  ✅ Path containment checks');
}

async function testSkillFileSizeLimit() {
  const ws = resolve(tmpdir(), `sc-skill-size-${Date.now()}`);
  await mkdir(ws, { recursive: true });

  // Create a skill with a normal file
  await createSkillDir(ws, 'normal', 'name: normal\ndescription: Normal skill');

  // Create a skill with oversized file
  const bigDir = join(ws, 'oversized');
  await mkdir(bigDir, { recursive: true });
  await writeFile(join(bigDir, 'SKILL.md'), '---\nname: oversized\ndescription: Big\n---\n' + 'x'.repeat(300_000));

  const skills = await loadAllSkills({ workspace: ws, logger: nullLogger, limits: { maxSkillFileBytes: 256_000 } });

  const names = skills.map((s) => s.name);
  if (!names.includes('normal')) throw new Error('Expected normal skill to load');
  if (names.includes('oversized')) throw new Error('Expected oversized skill to be skipped');

  await rm(ws, { recursive: true, force: true });
  console.log('  ✅ File size limit enforcement');
}

async function testSymlinkRejection() {
  // Skip on Windows if symlink requires elevation
  if (process.platform === 'win32') {
    console.log('  ⏭️  Symlink rejection (skipped on Windows)');
    return;
  }

  const ws = resolve(tmpdir(), `sc-skill-symlink-${Date.now()}`);
  await mkdir(ws, { recursive: true });

  // Create real skill dir
  await createSkillDir(ws, 'real', 'name: real\ndescription: Real skill');

  // Create symlink pointing outside workspace
  const escapeTarget = resolve(tmpdir(), `sc-skill-escape-${Date.now()}`);
  await mkdir(escapeTarget, { recursive: true });
  await writeFile(join(escapeTarget, 'SKILL.md'), '---\nname: escape\ndescription: Escaped\n---\n');

  const linkDir = join(ws, 'escape');
  try {
    await symlink(escapeTarget, linkDir);
  } catch {
    console.log('  ⏭️  Symlink rejection (symlink creation failed)');
    await rm(ws, { recursive: true, force: true });
    await rm(escapeTarget, { recursive: true, force: true });
    return;
  }

  const skills = await loadAllSkills({ workspace: ws, logger: nullLogger });
  const names = skills.map((s) => s.name);
  if (!names.includes('real')) throw new Error('Expected real skill to load');
  if (names.includes('escape')) throw new Error('Expected symlink-escaped skill to be rejected');

  await rm(ws, { recursive: true, force: true });
  await rm(escapeTarget, { recursive: true, force: true });
  console.log('  ✅ Symlink escape rejection');
}

async function testMaxSkillsPerSource() {
  const ws = resolve(tmpdir(), `sc-skill-max-${Date.now()}`);
  await mkdir(ws, { recursive: true });

  for (let i = 0; i < 5; i++) {
    await createSkillDir(ws, `skill-${i}`, `name: skill-${i}\ndescription: Skill ${i}`);
  }

  const skills = await loadAllSkills({ workspace: ws, logger: nullLogger, limits: { maxSkillsPerSource: 3 } });
  if (skills.length !== 3) {
    throw new Error(`Expected 3 skills (truncated), got ${skills.length}`);
  }

  await rm(ws, { recursive: true, force: true });
  console.log('  ✅ Max skills per source truncation');
}

// ─── Metadata Parsing ────────────────────────────────────────────────────────

async function testMetadataParsing() {
  const ws = resolve(tmpdir(), `sc-skill-meta-${Date.now()}`);
  await mkdir(ws, { recursive: true });

  await createSkillDir(
    ws,
    'meta',
    'name: meta\ndescription: Meta skill\nmetadata: {"os": ["darwin", "linux"], "requires": {"bins": ["gh"]}, "install": [{"kind": "brew", "command": "brew install gh"}]}'
  );

  const skills = await loadAllSkills({ workspace: ws, logger: nullLogger });
  const skill = skills.find((s) => s.name === 'meta');
  if (!skill) throw new Error('Expected meta skill to load');
  if (!skill.metadata) throw new Error('Expected metadata to be parsed');
  if (!skill.metadata.os?.includes('darwin')) throw new Error('Expected os to include darwin');
  if (!skill.metadata.requires?.bins?.includes('gh')) throw new Error('Expected requires.bins to include gh');
  if (skill.metadata.install?.[0]?.kind !== 'brew') throw new Error('Expected install kind to be brew');

  await rm(ws, { recursive: true, force: true });
  console.log('  ✅ Metadata JSON parsing');
}

async function testOpenClawMetadataCompatibility() {
  const ws = resolve(tmpdir(), `sc-skill-oc-${Date.now()}`);
  await mkdir(ws, { recursive: true });

  await createSkillDir(
    ws,
    'oc',
    'name: oc\ndescription: OpenClaw compat\nmetadata: {"openclaw": {"requires": {"bins": ["node"]}, "emoji": "🚀"}}'
  );

  const skills = await loadAllSkills({ workspace: ws, logger: nullLogger });
  const skill = skills.find((s) => s.name === 'oc');
  if (!skill) throw new Error('Expected oc skill to load');
  if (!skill.metadata?.requires?.bins?.includes('node')) {
    throw new Error('Expected openclaw metadata unwrap to work');
  }
  if (skill.metadata?.emoji !== '🚀') throw new Error('Expected emoji to be parsed');

  await rm(ws, { recursive: true, force: true });
  console.log('  ✅ OpenClaw metadata compatibility (unwrap)');
}

// ─── Eligibility Tests ───────────────────────────────────────────────────────

async function testEligibilityOsMatch() {
  const result = evaluateSkillEligibility({ os: [process.platform] });
  if (!result.eligible) throw new Error('Expected current platform to match');

  const resultBad = evaluateSkillEligibility({ os: ['nonexistent_os'] });
  if (resultBad.eligible) throw new Error('Expected nonexistent OS to fail');
  if (!resultBad.reason?.includes('OS mismatch')) throw new Error('Expected OS mismatch reason');

  console.log('  ✅ OS eligibility check');
}

async function testEligibilityBins() {
  // Check a command that almost certainly exists
  const knownBin = process.platform === 'win32' ? 'cmd' : 'ls';
  const result = evaluateSkillEligibility({ requires: { bins: [knownBin] } });
  if (!result.eligible) throw new Error(`Expected ${knownBin} to be found`);

  const resultMissing = evaluateSkillEligibility({ requires: { bins: ['this_command_definitely_does_not_exist_12345'] } });
  if (resultMissing.eligible) throw new Error('Expected missing bin to fail');

  const resultAny = evaluateSkillEligibility({ requires: { anyBins: ['nonexistent_1', knownBin] } });
  if (!resultAny.eligible) throw new Error('Expected anyBins to pass when one exists');

  console.log('  ✅ Bin eligibility checks');
}

async function testEligibilityEnv() {
  const result = evaluateSkillEligibility({ requires: { env: ['PATH'] } });
  if (!result.eligible) throw new Error('Expected PATH env to pass');

  const resultMissing = evaluateSkillEligibility({ requires: { env: ['THIS_ENV_DEFINITELY_DOES_NOT_EXIST_12345'] } });
  if (resultMissing.eligible) throw new Error('Expected missing env to fail');

  console.log('  ✅ Env eligibility checks');
}

async function testEligibilityAlways() {
  const result = evaluateSkillEligibility({ always: true, os: ['nonexistent'] });
  if (!result.eligible) throw new Error('Expected always: true to bypass checks');

  console.log('  ✅ Always flag bypass');
}

async function testEligibilityIntegration() {
  const ws = resolve(tmpdir(), `sc-skill-elig-${Date.now()}`);
  await mkdir(ws, { recursive: true });

  await createSkillDir(ws, 'eligible', 'name: eligible\ndescription: Eligible');
  await createSkillDir(
    ws,
    'ineligible',
    'name: ineligible\ndescription: Ineligible\nmetadata: {"requires": {"bins": ["this_command_definitely_does_not_exist_12345"]}}'
  );

  const skills = await loadAllSkills({ workspace: ws, logger: nullLogger });
  const eligible = skills.find((s) => s.name === 'eligible');
  const ineligible = skills.find((s) => s.name === 'ineligible');

  if (!eligible?.eligible) throw new Error('Expected eligible skill to be eligible');
  if (ineligible?.eligible) throw new Error('Expected ineligible skill to be ineligible');
  if (!ineligible?.ineligibleReason) throw new Error('Expected ineligibleReason');

  // formatSkillList should only include eligible skills
  const prompt = formatSkillList(skills);
  if (!prompt.includes('eligible')) throw new Error('Expected prompt to include eligible skill');
  if (prompt.includes('ineligible')) throw new Error('Expected prompt to exclude ineligible skill');

  await rm(ws, { recursive: true, force: true });
  console.log('  ✅ End-to-end eligibility filtering');
}

// ─── Hot Reload ──────────────────────────────────────────────────────────────

async function testSkillWatcher() {
  const ws = resolve(tmpdir(), `sc-skill-watch-${Date.now()}`);
  await mkdir(ws, { recursive: true });
  await createSkillDir(ws, 'initial', 'name: initial\ndescription: Initial');

  let reloadCount = 0;
  let lastSkills = [];

  const watcher = new SkillWatcher(
    [ws],
    async () => {
      reloadCount++;
      lastSkills = await loadAllSkills({ workspace: ws, logger: nullLogger });
    },
    nullLogger,
    100 // fast debounce for testing
  );

  watcher.start();

  // Wait for initial stability
  await new Promise((r) => setTimeout(r, 50));

  // Add a new skill
  await createSkillDir(ws, 'added', 'name: added\ndescription: Added skill');

  // Wait for debounce + reload
  await new Promise((r) => setTimeout(r, 300));

  watcher.stop();

  if (reloadCount === 0) throw new Error('Expected watcher to trigger reload');
  const names = lastSkills.map((s) => s.name);
  if (!names.includes('added')) throw new Error('Expected reloaded skills to include added skill');

  await rm(ws, { recursive: true, force: true });
  console.log('  ✅ Skill watcher hot-reload');
}

// ─── Source Priority ─────────────────────────────────────────────────────────

async function testSourcePriority() {
  const ws = resolve(tmpdir(), `sc-skill-prio-${Date.now()}`);
  await mkdir(ws, { recursive: true });

  // Workspace skill
  await createSkillDir(ws, 'shared', 'name: shared\ndescription: Workspace version');

  const skills = await loadAllSkills({ workspace: ws, logger: nullLogger });
  const shared = skills.find((s) => s.name === 'shared');
  if (!shared) throw new Error('Expected shared skill to exist');
  if (shared.source !== 'workspace') throw new Error('Expected workspace source');

  await rm(ws, { recursive: true, force: true });
  console.log('  ✅ Source priority resolution');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testPathWithinRoot,
    testSkillFileSizeLimit,
    testSymlinkRejection,
    testMaxSkillsPerSource,
    testMetadataParsing,
    testOpenClawMetadataCompatibility,
    testEligibilityOsMatch,
    testEligibilityBins,
    testEligibilityEnv,
    testEligibilityAlways,
    testEligibilityIntegration,
    testSkillWatcher,
    testSourcePriority,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (e) {
      console.log(`  ❌ ${test.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed}/${tests.length} skill production tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

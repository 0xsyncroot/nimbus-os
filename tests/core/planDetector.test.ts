import { describe, expect, test } from 'bun:test';
import { detectPlanMode, renderPlanCue, PLAN_CUE_BLOCK } from '../../src/core/planDetector.ts';

describe('SPEC-108: planDetector', () => {
  test('H1 cue word general', () => {
    const d = detectPlanMode('organize my Downloads folder');
    expect(d.plan).toBe(true);
    expect(d.matchedHeuristic).toBe('H1');
  });

  test('H1 research', () => {
    const d = detectPlanMode('research best laptop under 30 triệu');
    expect(d.plan).toBe(true);
  });

  test('H1 code', () => {
    const d = detectPlanMode('refactor auth flow');
    expect(d.plan).toBe(true);
  });

  test('H1 case insensitive word boundary', () => {
    expect(detectPlanMode('Plan this trip').plan).toBe(true);
    expect(detectPlanMode('replanxyz').plan).toBe(false);
  });

  test('H2 tool mentions', () => {
    const d = detectPlanMode('read the mail then check calendar then write a reply');
    expect(d.plan).toBe(true);
  });

  test('H3 scope ≥5', () => {
    const d = detectPlanMode('update 7 files in src/');
    expect(d.plan).toBe(true);
    expect(d.matchedHeuristic).toBe('H3');
  });

  test('H3 email scope', () => {
    const d = detectPlanMode('reply to 12 emails');
    expect(d.plan).toBe(true);
  });

  test('casual query returns plan=false', () => {
    expect(detectPlanMode('mấy giờ rồi?').plan).toBe(false);
    expect(detectPlanMode('hi').plan).toBe(false);
  });

  test('renderPlanCue outputs block marker when plan=true', () => {
    const d = detectPlanMode('organize downloads');
    const cue = renderPlanCue(d);
    expect(cue).toContain(PLAN_CUE_BLOCK);
    expect(cue).toContain('H1');
  });

  test('renderPlanCue empty when plan=false', () => {
    expect(renderPlanCue({ plan: false, reason: 'x' })).toBe('');
  });
});

import { describe, expect, test } from 'bun:test';
import { InitAnswersSchema, shouldAskBashPreset } from '../../src/onboard/questions.ts';

describe('SPEC-901: questions validators', () => {
  test('workspace name regex rejects invalid, accepts valid', () => {
    const bases = {
      primaryUseCase: 'daily assistant',
      voice: 'casual' as const,
      language: 'en' as const,
      provider: 'anthropic' as const,
      modelClass: 'workhorse' as const,
      bashPreset: 'balanced' as const,
    };
    expect(() => InitAnswersSchema.parse({ ...bases, workspaceName: '1name' })).toThrow();
    expect(() => InitAnswersSchema.parse({ ...bases, workspaceName: 'UPPER' })).toThrow();
    expect(() => InitAnswersSchema.parse({ ...bases, workspaceName: 'a' })).toThrow();
    expect(InitAnswersSchema.parse({ ...bases, workspaceName: 'my-ws' }).workspaceName).toBe('my-ws');
    expect(InitAnswersSchema.parse({ ...bases, workspaceName: 'personal' }).workspaceName).toBe('personal');
  });

  test('bashPreset prompt shown for dev use-cases', () => {
    expect(shouldAskBashPreset('coding project')).toBe(true);
    expect(shouldAskBashPreset('software engineer helper')).toBe(true);
    expect(shouldAskBashPreset('dev workflow')).toBe(true);
    expect(shouldAskBashPreset('programming assistant')).toBe(true);
    expect(shouldAskBashPreset('CODE review')).toBe(true);
  });

  test('bashPreset prompt skipped for non-dev', () => {
    expect(shouldAskBashPreset('daily assistant')).toBe(false);
    expect(shouldAskBashPreset('life organizer')).toBe(false);
    expect(shouldAskBashPreset('student')).toBe(false);
    expect(shouldAskBashPreset('writer')).toBe(false);
  });

  test('voice + language + provider enum enforced', () => {
    const bases = {
      workspaceName: 'ws-x',
      primaryUseCase: 'daily assistant',
      voice: 'chatty' as unknown as 'casual',
      language: 'en' as const,
      provider: 'anthropic' as const,
      modelClass: 'workhorse' as const,
      bashPreset: 'balanced' as const,
    };
    expect(() => InitAnswersSchema.parse(bases)).toThrow();
  });
});

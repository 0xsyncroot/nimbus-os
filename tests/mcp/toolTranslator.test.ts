// tests/mcp/toolTranslator.test.ts — SPEC-306: Tool translator unit tests.

import { describe, expect, test } from 'bun:test';
import {
  translateMcpTool,
  translateMcpTools,
  type McpToolDescriptor,
} from '../../src/mcp/toolTranslator.ts';
import { buildMcpToolName, collidesWithBuiltin, BUILTIN_TOOL_NAMES } from '../../src/mcp/mcpNames.ts';
import { capToolDescription, MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/mcpSecurity.ts';

describe('SPEC-306: MCP tool translator', () => {
  // ---- buildMcpToolName -------------------------------------------------------

  test('T4-01: builds mcp__server__tool name', () => {
    expect(buildMcpToolName('myserver', 'search')).toBe('mcp__myserver__search');
  });

  test('T4-02: sanitizes special chars in server + tool', () => {
    expect(buildMcpToolName('my-server.v2', 'find/files')).toBe('mcp__my_server_v2__find_files');
  });

  test('T4-03: empty parts still produce valid prefix', () => {
    expect(buildMcpToolName('s', 't')).toBe('mcp__s__t');
  });

  // ---- Built-in collision -------------------------------------------------------

  test('T4-04: collidesWithBuiltin detects Read collision', () => {
    expect(collidesWithBuiltin('Read')).toBe(true);
  });

  test('T4-05: collidesWithBuiltin detects Write collision', () => {
    expect(collidesWithBuiltin('Write')).toBe(true);
  });

  test('T4-06: non-builtin tool does not collide', () => {
    expect(collidesWithBuiltin('search')).toBe(false);
    expect(collidesWithBuiltin('mcp__s__Read')).toBe(false);
  });

  test('T4-07: all built-in names are in the set', () => {
    for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Memory']) {
      expect(BUILTIN_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  // ---- translateMcpTool -------------------------------------------------------

  test('T4-08: MCP tool named Read → mcp__srv__Read, built-in Read unaffected', () => {
    const descriptor: McpToolDescriptor = {
      name: 'Read',
      serverName: 'srv',
      description: 'read a file from server',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    };
    const td = translateMcpTool(descriptor);
    expect(td.name).toBe('mcp__srv__Read');
    // Built-in 'Read' is still in the set
    expect(BUILTIN_TOOL_NAMES.has('Read')).toBe(true);
  });

  test('T4-09: description is capped at 2048 chars', () => {
    const longDesc = 'x'.repeat(3000);
    const descriptor: McpToolDescriptor = {
      name: 'big',
      serverName: 'srv',
      description: longDesc,
    };
    const td = translateMcpTool(descriptor);
    expect(td.description.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(td.description.endsWith('…')).toBe(true);
  });

  test('T4-10: short description passes through unchanged', () => {
    const descriptor: McpToolDescriptor = {
      name: 'find',
      serverName: 'filesrv',
      description: 'Find a file',
    };
    const td = translateMcpTool(descriptor);
    expect(td.description).toBe('Find a file');
  });

  // ---- translateMcpTools (bulk) -----------------------------------------------

  test('bulk translate produces correct count + names', () => {
    const tools = [
      { name: 'alpha', description: 'Alpha tool' },
      { name: 'beta', description: 'Beta tool' },
      { name: 'gamma', description: 'Gamma tool' },
    ];
    const result = translateMcpTools('myserver', tools);
    expect(result.length).toBe(3);
    expect(result[0]!.name).toBe('mcp__myserver__alpha');
    expect(result[1]!.name).toBe('mcp__myserver__beta');
    expect(result[2]!.name).toBe('mcp__myserver__gamma');
  });

  test('bulk translate deduplicates by namespaced name', () => {
    const tools = [
      { name: 'dup', description: 'First' },
      { name: 'dup', description: 'Second' },
    ];
    const result = translateMcpTools('s', tools);
    expect(result.length).toBe(1);
    expect(result[0]!.description).toBe('First');
  });

  test('inputSchema falls back to empty object schema when absent', () => {
    const descriptor: McpToolDescriptor = { name: 'noop', serverName: 'srv' };
    const td = translateMcpTool(descriptor);
    expect(td.inputSchema).toMatchObject({ type: 'object' });
  });

  // ---- capToolDescription (standalone) ----------------------------------------

  test('capToolDescription: exactly at limit passes through', () => {
    const s = 'a'.repeat(MAX_TOOL_DESCRIPTION_CHARS);
    expect(capToolDescription(s)).toBe(s);
  });

  test('capToolDescription: one over truncates and appends ellipsis', () => {
    const s = 'b'.repeat(MAX_TOOL_DESCRIPTION_CHARS + 1);
    const capped = capToolDescription(s);
    expect(capped.length).toBe(MAX_TOOL_DESCRIPTION_CHARS);
    expect(capped.endsWith('…')).toBe(true);
  });
});

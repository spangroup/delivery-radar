// The agent loop: model -> tool calls -> tool results -> model ... -> submit_report.
// Plain Anthropic Messages API tool use, no framework, so every step is visible and testable.

import { validateReport } from './validate.js';

const MAX_TOOL_RESULT_CHARS = 20_000;

function toContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_TOOL_RESULT_CHARS
    ? text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`
    : text;
}

export async function runAgent({
  client,
  model,
  system,
  userPrompt,
  tools,
  maxSteps = 25,
  maxTokens = 8000,
  onStep = () => {},
}) {
  const messages = [{ role: 'user', content: userPrompt }];
  const trace = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let nudged = false;

  for (let step = 1; step <= maxSteps; step++) {
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      tools: tools.specs,
      messages,
    });
    usage.input_tokens += resp.usage?.input_tokens || 0;
    usage.output_tokens += resp.usage?.output_tokens || 0;
    messages.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      if (!nudged) {
        nudged = true;
        messages.push({ role: 'user', content: 'Please finish by calling submit_report with your findings.' });
        continue;
      }
      throw new Error(`Agent stopped without submitting a report (stop_reason: ${resp.stop_reason}).`);
    }

    const results = [];
    for (const call of toolUses) {
      onStep({ step, tool: call.name, input: call.input });

      if (call.name === 'submit_report') {
        const errors = validateReport(call.input);
        if (errors.length === 0) {
          trace.push({ step, tool: call.name, ok: true });
          return { report: call.input, steps: step, trace, usage };
        }
        trace.push({ step, tool: call.name, ok: false, error: errors.join('; ') });
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Report rejected. Fix and resubmit: ${errors.join('; ')}` });
        continue;
      }

      const handler = tools.handlers[call.name];
      if (!handler) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Unknown tool: ${call.name}` });
        trace.push({ step, tool: call.name, ok: false, error: 'unknown tool' });
        continue;
      }
      try {
        const out = await handler(call.input || {});
        results.push({ type: 'tool_result', tool_use_id: call.id, content: toContent(out) });
        trace.push({ step, tool: call.name, input: call.input, ok: true });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Tool error: ${err.message}` });
        trace.push({ step, tool: call.name, input: call.input, ok: false, error: err.message });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  throw new Error(`Agent did not submit a report within ${maxSteps} steps.`);
}

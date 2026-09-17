#!/usr/bin/env node

import { readSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const INPUT_WAIT = new Int32Array(new SharedArrayBuffer(4));

function readInput(
  buffer: Uint8Array,
  offset = 0,
  length = buffer.length,
): number {
  while (true) {
    try {
      return readSync(0, buffer, offset, length, null);
    } catch (error) {
      if (
        error instanceof Error && "code" in error &&
        (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
      ) {
        Atomics.wait(INPUT_WAIT, 0, 0, 10);
        continue;
      }
      throw error;
    }
  }
}
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const FAINT = "\x1b[2m";
const RULE = "─".repeat(58);

type Question =
  | {
    type: "noul";
    instructions: string;
    criteria?: { true: string; false: string };
  }
  | {
    type: "choice";
    instructions: string;
    criteria: Record<string, string | null>;
  }
  | { type: "score"; instructions: string; criteria: string[] };

type Answer = {
  type?: string;
  noul?: number;
  score?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, unknown>;
  confidence?: number;
};

type Result = {
  answer: Answer;
  model: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
};

function clear(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

function screen(
  title: string,
  subtitle = "",
  context = "",
  question = "",
): void {
  clear();
  console.log(`${BOLD}judged${RESET}  ${FAINT}${MODEL}${RESET}`);
  console.log(`${FAINT}${RULE}${RESET}`);
  if (context) {
    console.log(`\n${FAINT}context${RESET}`);
    console.log(context);
  }
  if (question) {
    console.log(`\n${FAINT}question${RESET}`);
    console.log(question);
  }
  if (context || question) console.log(`\n${FAINT}${RULE}${RESET}`);
  console.log(`\n${BOLD}${title}${RESET}`);
  if (subtitle) console.log(`${FAINT}${subtitle}${RESET}`);
  console.log("");
}

function prompt(label = ""): string | null {
  process.stdout.write(label === "" ? "" : `${label} `);
  const bytes: number[] = [];
  const byte = new Uint8Array(1);
  while (true) {
    const count = readInput(byte, 0, 1);
    if (count === 0) return bytes.length === 0
      ? null
      : new TextDecoder().decode(Uint8Array.from(bytes));
    if (byte[0] === 10 || byte[0] === 13) {
      return new TextDecoder().decode(Uint8Array.from(bytes));
    }
    bytes.push(byte[0]);
  }
}

function line(label: string): string | null {
  const answer = prompt(`${BOLD}${label}${RESET}`);
  return answer === null ? null : answer.trim();
}

async function paragraph(label: string, hint: string): Promise<string | null> {
  if (label) console.log(`${BOLD}${label}${RESET}`);
  console.log(
    `${FAINT}${hint ? `${hint} · ` : ""}Enter sends · Shift/Option+Enter adds a line${RESET}`,
  );
  if (!process.stdin.isTTY) {
    const answer = prompt("›");
    return answer === null ? null : answer.trim();
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let value = "";
  let pending = "";
  let pasting = false;
  let renderedLines = 0;

  const write = (text: string) => process.stdout.write(encoder.encode(text));
  const render = () => {
    if (renderedLines > 0) {
      write("\r\x1b[2K");
      for (let index = 1; index < renderedLines; index += 1) {
        write("\x1b[1A\r\x1b[2K");
      }
    }
    const shown = value.replaceAll("\n", "\n  ");
    write(`${FAINT}›${RESET} ${shown}`);
    renderedLines = value.split("\n").length;
  };

  process.stdin.setRawMode(true);
  write("\x1b[?2004h");
  render();
  try {
    const buffer = new Uint8Array(1024);
    while (true) {
      const count = readInput(buffer);
      if (count === 0) return null;
      pending += decoder.decode(buffer.subarray(0, count), { stream: true });
      let changed = false;

      while (pending.length > 0) {
        if (pasting) {
          const end = pending.indexOf("\x1b[201~");
          if (end < 0) {
            value += pending.replace(/\r\n?/g, "\n");
            pending = "";
            changed = true;
            break;
          }
          value += pending.slice(0, end).replace(/\r\n?/g, "\n");
          pending = pending.slice(end + 6);
          pasting = false;
          changed = true;
          continue;
        }
        if (pending.startsWith("\x1b[200~")) {
          pending = pending.slice(6);
          pasting = true;
          continue;
        }
        if (pending.startsWith("\x1b\r") || pending.startsWith("\x1b\n")) {
          value += "\n";
          pending = pending.slice(2);
          changed = true;
          continue;
        }
        const modifiedEnter = pending.match(/^\x1b\[13;[234]u/);
        if (modifiedEnter) {
          value += "\n";
          pending = pending.slice(modifiedEnter[0].length);
          changed = true;
          continue;
        }
        if (pending[0] === "\r" || pending[0] === "\n") {
          write("\n");
          return value.trim();
        }
        if (pending[0] === "\u0003" || pending[0] === "\u0004") {
          write("\n");
          return null;
        }
        if (pending[0] === "\u007f" || pending[0] === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          pending = pending.slice(1);
          changed = true;
          continue;
        }
        if (pending[0] === "\x1b") {
          const sequence = pending.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
          if (!sequence) break;
          pending = pending.slice(sequence[0].length);
          continue;
        }
        const character = Array.from(pending)[0];
        value += character;
        pending = pending.slice(character.length);
        changed = true;
      }
      if (changed) render();
    }
  } finally {
    write("\x1b[?2004l");
    process.stdin.setRawMode(false);
  }
}

function choose(
  label: string,
  options: Array<[string, string]>,
): number | null {
  for (const [index, [name, hint]] of options.entries()) {
    const detail = hint ? `  ${FAINT}${hint}${RESET}` : "";
    console.log(`  ${BOLD}${index + 1}${RESET}  ${name}${detail}`);
  }
  while (true) {
    const answer = line(`${label} [1]`);
    if (answer === null) return null;
    const index = answer === "" ? 0 : Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return index;
    }
    console.log(`${FAINT}Enter a number from 1 to ${options.length}.${RESET}`);
  }
}

async function secret(label: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const write = (text: string) => process.stdout.write(encoder.encode(text));
  let value = "";
  process.stdin.setRawMode(true);
  write(label);
  try {
    const buffer = new Uint8Array(1024);
    while (true) {
      const count = readInput(buffer);
      if (count === 0) return null;
      const input = decoder.decode(buffer.subarray(0, count), { stream: true });
      for (const character of input) {
        if (character === "\r" || character === "\n") {
          write("\n");
          return value.trim();
        }
        if (character === "\u0003" || character === "\u0004") {
          write("\n");
          return null;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character >= " ") value += character;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
  }
}

async function resolveToken(): Promise<string | null> {
  for (const name of ["TYPESAFE_API_KEY", "JEV_API_TOKEN"] as const) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  const home = process.env.HOME;
  if (!home) return null;
  const directory = `${home}/.config/judged`;
  const path = `${directory}/token`;
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (value) return value;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  console.log("No TypeSafe API key was found.");
  const value = await secret("API key (input hidden): ");
  if (!value) return null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  console.log(`Saved the key to ${path}.`);
  return value;
}

function buildNoul(instructions: string): Question | null {
  const yes = line("yes means (optional)");
  if (yes === null) return null;
  if (yes === "") return { type: "noul", instructions };
  const no = line("no means");
  if (no === null) return null;
  if (no === "") {
    console.log(`${FAINT}Both meanings are required; sending neither.${RESET}`);
    return { type: "noul", instructions };
  }
  return { type: "noul", instructions, criteria: { true: yes, false: no } };
}

function buildChoice(
  instructions: string,
  context: string,
): Question | null {
  const criteria: Record<string, string | null> = {};
  while (true) {
    screen("choice", "", context, instructions);
    const entries = Object.entries(criteria);
    if (entries.length > 0) {
      for (const [index, [name, description]] of entries.entries()) {
        console.log(`${BOLD}${index + 1}  ${name}${RESET}`);
        if (description) console.log(`   ${FAINT}${description}${RESET}`);
      }
      console.log("");
    }

    console.log(`${FAINT}option ${entries.length + 1}${RESET}`);
    const name = line("name");
    if (name === null) return null;
    if (name === "") {
      console.log(`${FAINT}Name required.${RESET}`);
      prompt("Press Enter");
      continue;
    }
    if (Object.hasOwn(criteria, name)) {
      console.log(`${FAINT}${name} already exists.${RESET}`);
      prompt("Press Enter");
      continue;
    }
    const description = line("description (optional)");
    if (description === null) return null;
    criteria[name] = description || null;

    if (Object.keys(criteria).length === 255) break;
    if (Object.keys(criteria).length >= 2) {
      const another = line("add another? [y/N]");
      if (another === null) return null;
      if (!another.toLowerCase().startsWith("y")) break;
    }
  }
  return { type: "choice", instructions, criteria };
}

function buildScore(instructions: string): Question | null {
  console.log(`${FAINT}low → high · Enter when complete${RESET}\n`);
  const criteria: string[] = [];
  while (true) {
    const value = prompt(`${BOLD}${criteria.length + 1}${RESET}`);
    if (value === null) return null;
    if (value.trim() === "") {
      if (criteria.length >= 2) break;
      console.log(`${FAINT}Add at least two levels.${RESET}`);
      continue;
    }
    if (criteria.length === 10) {
      console.log(`${FAINT}10 levels maximum.${RESET}`);
      continue;
    }
    criteria.push(value.trim());
  }
  return { type: "score", instructions, criteria };
}

async function callApi(
  token: string,
  state: string,
  question: Question,
): Promise<Result> {
  const questions = { judgment: question };
  const stateTokens = Math.ceil(state.length / 4);
  const questionTokens = Math.ceil(JSON.stringify(questions).length / 4);
  if (stateTokens + questionTokens > 64_000) {
    throw new Error("The request is above the 64,000-token limit.");
  }
  if (stateTokens + questionTokens > 32_000) {
    throw new Error(
      "The context and question are above the 32,000-token limit.",
    );
  }
  const started = performance.now();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ state, model: MODEL, questions }),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const payload = JSON.parse(text);
      detail = payload?.error?.message ?? payload?.message ?? "";
    } catch {
      detail = text.trim();
    }
    if (response.status === 401) {
      throw new Error("The service rejected the token.");
    }
    throw new Error(
      `The service returned ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const payload = JSON.parse(text);
  const answer = payload?.answers?.judgment;
  if (!answer) {
    throw new Error("The service returned no answer for this question.");
  }
  return {
    answer,
    model: payload.model ?? MODEL,
    inputTokens: Number(payload.usage?.input_tokens ?? 0),
    outputTokens: Number(payload.usage?.output_tokens ?? 0),
    elapsedMs: performance.now() - started,
  };
}

function percent(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, number)) * 100)}%`;
}

function renderResult(result: Result, context: string, question: string): void {
  screen("answer", "", context, question);
  const answer = result.answer;
  if (answer.type === "noul") {
    const yes = Number(answer.noul);
    console.log(`${BOLD}yes  ${percent(yes)}${RESET}`);
    console.log(`no   ${percent(1 - yes)}`);
  } else if (answer.type === "choice") {
    const ranked = Object.entries(answer.probabilities ?? {}).sort((a, b) =>
      b[1] - a[1]
    );
    const width = Math.max(0, ...ranked.map(([name]) => name.length));
    for (const [index, [name, probability]] of ranked.entries()) {
      const row = `${name.padEnd(width)}  ${percent(probability)}`;
      console.log(index === 0 ? `${BOLD}${row}${RESET}` : row);
    }
  } else if (answer.type === "score") {
    if (Number.isFinite(Number(answer.score))) {
      console.log(`${BOLD}score  ${Number(answer.score).toFixed(2)}${RESET}\n`);
    }
    const probabilities = answer.probabilities ?? {};
    const rows = Object.entries(answer.legend ?? {}).map((
      [index, meaning],
    ) => ({
      index,
      meaning: String(meaning),
      probability: Number(probabilities[index] ?? 0),
    }));
    const width = Math.max(
      0,
      ...rows.map(({ index, meaning }) => index.length + meaning.length + 1),
    );
    const leader = Math.max(0, ...rows.map(({ probability }) => probability));
    for (const { index, meaning, probability } of rows) {
      const label = `${index} ${meaning}`.padEnd(width);
      const row = `${label}  ${percent(probability)}`;
      console.log(probability === leader ? `${BOLD}${row}${RESET}` : row);
    }
  } else {
    console.log("The service returned an answer this client cannot display.");
  }
  const confidence = Number(answer.confidence);
  const metadata = [
    Number.isFinite(confidence) ? `confidence ${confidence.toFixed(2)}` : null,
    result.model,
    `${result.inputTokens} in`,
    `${result.outputTokens} out`,
    `${(result.elapsedMs / 1000).toFixed(1)}s`,
  ].filter(Boolean).join("  ·  ");
  console.log(`\n${FAINT}${metadata}${RESET}`);
}

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    console.error("judged has no commands. Run it without arguments.");
    return 2;
  }
  const token = await resolveToken();
  if (!token) {
    console.error(
      "judged needs TYPESAFE_API_KEY, JEV_API_TOKEN, or ~/.config/judged/token.",
    );
    return 3;
  }

  let state: string | null = null;
  session:
  while (true) {
    if (state === null) {
      screen("context");
      state = await paragraph("", "");
      if (state === null) break;
      if (state === "") {
        console.log(`${FAINT}Context cannot be empty.${RESET}`);
        prompt("Press Enter to try again");
        state = null;
        continue;
      }
    }

    screen("question", "", state);
    const instructions = await paragraph("", "");
    if (instructions === null) break;
    if (instructions === "") {
      console.log(`${FAINT}Question cannot be empty.${RESET}`);
      prompt("Press Enter to try again");
      continue;
    }

    screen("answer type", "", state, instructions);
    const type = choose("select", [
      ["yes / no", "probability of yes"],
      ["choice", "probability per option"],
      ["score", "position on a scale"],
    ]);
    if (type === null) break;

    const titles = ["yes / no", "choice", "score"];
    screen(titles[type], "", state, instructions);
    const question = type === 0
      ? buildNoul(instructions)
      : type === 1
      ? buildChoice(instructions, state)
      : buildScore(instructions);
    if (question === null) break;

    while (true) {
      screen("judging", "", state, instructions);
      let failed = false;
      try {
        const result = await callApi(token, state, question);
        renderResult(result, state, instructions);
      } catch (error) {
        failed = true;
        screen(
          "request failed",
          error instanceof Error ? error.message : String(error),
          state,
          instructions,
        );
      }

      console.log("");
      const actions: Array<[string, string]> = failed
        ? [
          ["retry", ""],
          ["another", "same context"],
          ["new context", ""],
          ["quit", ""],
        ]
        : [
          ["another", "same context"],
          ["new context", ""],
          ["quit", ""],
        ];
      const selected = choose("next", actions);
      if (selected === null) break session;
      if (failed && selected === 0) continue;
      const next = failed ? selected - 1 : selected;
      if (next === 2) break session;
      if (next === 1) state = null;
      break;
    }
  }

  return 0;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main();
}

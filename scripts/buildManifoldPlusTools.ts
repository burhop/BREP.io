export type CommandCandidate = {
  command: string;
  args: string[];
  label: string;
};

export type CommandProbeResult = {
  ok: boolean;
  detail: string;
  output?: string;
};

export type CommandProbeAttempt = CommandProbeResult & {
  candidate: CommandCandidate;
};

export function getPythonCandidates(platform: NodeJS.Platform): CommandCandidate[] {
  const candidates = [
    { command: "python3", args: [], label: "python3" },
    { command: "python", args: [], label: "python" },
  ];

  if (platform === "win32") {
    candidates.push({ command: "py", args: ["-3"], label: "py -3" });
  }

  return candidates;
}

export function getCmakeCandidates(cachedCmakeBinary: string): CommandCandidate[] {
  return [
    { command: "cmake", args: [], label: "cmake on PATH" },
    {
      command: cachedCmakeBinary,
      args: [],
      label: `cached cmake (${cachedCmakeBinary})`,
    },
  ];
}

export function getNinjaCandidates(cachedNinjaBinary: string): CommandCandidate[] {
  return [
    { command: "ninja", args: [], label: "ninja on PATH" },
    {
      command: cachedNinjaBinary,
      args: [],
      label: `cached ninja (${cachedNinjaBinary})`,
    },
  ];
}

export function selectFirstWorkingCommand(
  candidates: CommandCandidate[],
  probe: (candidate: CommandCandidate) => CommandProbeResult
): { selected: CommandCandidate | null; attempts: CommandProbeAttempt[] } {
  const attempts: CommandProbeAttempt[] = [];

  for (const candidate of candidates) {
    const result = probe(candidate);
    attempts.push({ candidate, ...result });
    if (result.ok) {
      return { selected: candidate, attempts };
    }
  }

  return { selected: null, attempts };
}

export function formatProbeAttempts(attempts: CommandProbeAttempt[]): string {
  return attempts
    .map(({ candidate, detail }) => `- ${candidate.label}: ${detail}`)
    .join("\n");
}

function quoteForBash(value: string): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function quoteForWindowsCommand(value: string): string {
  const text = String(value);
  if (/^[A-Za-z0-9_./\\:+=,-]+$/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function isWindowsBatchCommand(command: string): boolean {
  const basename = command.replaceAll("\\", "/").split("/").at(-1) || command;
  return /^(emcmake|emcc|em\+\+)(\.bat)?$/i.test(basename) || /\.(bat|cmd)$/i.test(basename);
}

export type EmscriptenCommandPlanOptions = {
  platform: NodeJS.Platform;
  rootDir: string;
  emsdkDir: string;
  emsdkLauncher: string;
  emsdkEnvScript: string;
  emsdkVersion: string;
  emCacheDir: string;
  command: string;
  args: string[];
  commandInterpreter?: string;
};

export function createEmscriptenCommandPlan(
  options: EmscriptenCommandPlanOptions
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const {
    platform,
    rootDir,
    emsdkDir,
    emsdkLauncher,
    emsdkEnvScript,
    emsdkVersion,
    emCacheDir,
    command,
    args,
  } = options;

  if (platform === "win32") {
    const invocation = [command, ...args].map(quoteForWindowsCommand).join(" ");
    const commandPrefix = isWindowsBatchCommand(command) ? "call " : "";
    const commandText = [
      'set "EMSDK_QUIET=1"',
      `call ${quoteForWindowsCommand(emsdkLauncher)} install ${quoteForWindowsCommand(emsdkVersion)} >nul`,
      `call ${quoteForWindowsCommand(emsdkLauncher)} activate ${quoteForWindowsCommand(emsdkVersion)} >nul`,
      `call ${quoteForWindowsCommand(emsdkEnvScript)} >nul`,
      `set "EM_CACHE=${emCacheDir.replaceAll('"', '""')}"`,
      `cd /d ${quoteForWindowsCommand(rootDir)}`,
      `${commandPrefix}${invocation}`,
    ].join(" && ");

    return {
      command: options.commandInterpreter || "cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", commandText],
      windowsVerbatimArguments: true,
    };
  }

  const quotedCache = quoteForBash(emCacheDir);
  const commandText = [command, ...args].map(quoteForBash).join(" ");
  return {
    command: "bash",
    args: [
      "-c",
      [
        "set -eo pipefail",
        `cd ${quoteForBash(emsdkDir)}`,
        `./emsdk install ${quoteForBash(emsdkVersion)} >/dev/null`,
        `./emsdk activate ${quoteForBash(emsdkVersion)} >/dev/null`,
        `source ${quoteForBash(emsdkEnvScript)} >/dev/null`,
        `export EM_CACHE=${quotedCache}`,
        `mkdir -p ${quotedCache}`,
        `cd ${quoteForBash(rootDir)}`,
        commandText,
      ].join(" && "),
    ],
  };
}

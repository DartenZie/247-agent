import { emit, EMIT_USAGE } from './commands/emit.js';
import { run, RUN_USAGE } from './commands/run.js';
import { validate, VALIDATE_USAGE } from './commands/validate.js';
import { EXIT, processIo, UsageError, type Io } from './io.js';

export const USAGE = `usage: oa <command> [args]

commands:
  validate <file>...                 validate tasks files / agent.yaml against the schema
  run <task> [--event f.json]        queue a run of a task by hand (--wait to block)
  emit <type> [payload.json|-]       inject an event
  help [command]

The daemon socket is --socket, else $OA_CORE_SOCKET, else /run/online-agent/core.sock.
`;

const COMMAND_USAGE: Record<string, string> = {
  validate: VALIDATE_USAGE,
  run: RUN_USAGE,
  emit: EMIT_USAGE,
};

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'validate':
        return validate(rest, io);
      case 'run':
        return await run(rest, io);
      case 'emit':
        return await emit(rest, io);
      case undefined:
      case 'help':
      case '--help':
      case '-h': {
        const topic = rest[0];
        io.out((topic === undefined ? USAGE : COMMAND_USAGE[topic]) ?? USAGE);
        return command === undefined ? EXIT.usage : EXIT.ok;
      }
      default:
        io.err(`unknown command "${command}"`);
        io.err(USAGE);
        return EXIT.usage;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(err.message);
      io.err(command === undefined ? USAGE : (COMMAND_USAGE[command] ?? USAGE));
      return EXIT.usage;
    }
    // parseArgs rejects unknown flags with a coded TypeError.
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')
    ) {
      io.err(err.message);
      io.err(command === undefined ? USAGE : (COMMAND_USAGE[command] ?? USAGE));
      return EXIT.usage;
    }
    throw err;
  }
}

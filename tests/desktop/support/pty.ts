import type { IPty, IPtyForkOptions } from "node-pty"
import { vi } from "vitest"

/** A pseudo-terminal that records what is written and lets a test speak for the shell. */
export function fakePty() {
  const data: ((chunk: string) => void)[] = []
  const exits: ((event: { exitCode: number; signal?: number }) => void)[] = []
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (listener: (chunk: string) => void) => {
      data.push(listener)
      return { dispose() {} }
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exits.push(listener)
      return { dispose() {} }
    },
  } as unknown as IPty & {
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }
  return {
    pty,
    spawn: vi.fn((_file: string, _args: string | string[], _options: IPtyForkOptions) => pty),
    print: (chunk: string) => {
      for (const listener of data) listener(chunk)
    },
    exit: () => {
      for (const listener of exits) listener({ exitCode: 0 })
    },
  }
}

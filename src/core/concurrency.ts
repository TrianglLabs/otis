/**
 * Drives several async generators concurrently, yielding each event as soon as any generator produces it, and
 * returns their results in the original order once every generator has finished.
 */
export async function* mergeGenerators<TEvent, TReturn>(
  generators: readonly AsyncGenerator<TEvent, TReturn>[],
): AsyncGenerator<TEvent, TReturn[]> {
  const results: TReturn[] = new Array(generators.length)
  const pending = new Map<number, Promise<{ index: number; step: IteratorResult<TEvent, TReturn> }>>()
  const advance = (index: number) => {
    pending.set(
      index,
      generators[index].next().then((step) => ({ index, step })),
    )
  }
  for (let index = 0; index < generators.length; index += 1) advance(index)

  while (pending.size > 0) {
    const { index, step } = await Promise.race(pending.values())
    if (step.done) {
      pending.delete(index)
      results[index] = step.value
      continue
    }
    advance(index)
    yield step.value
  }
  return results
}

/** Wraps an async function so concurrent callers run one at a time, in call order. */
export function serialized<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  let tail: Promise<unknown> = Promise.resolve()
  return (...args) => {
    const run = tail.then(() => fn(...args))
    tail = run.catch(() => undefined)
    return run
  }
}

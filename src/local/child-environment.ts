export function childProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env }
  delete childEnv.FIREWORKS_API_KEY
  delete childEnv.PARALLEL_API_KEY
  return childEnv
}

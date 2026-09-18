/** A desktop app can outlive the terminal or development harness that launched it. */
export function handleClosedOutput(stream: NodeJS.EventEmitter) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    // Only the launcher's output pipe is optional. Do not hide unrelated I/O or application errors.
    if (error.code !== "EPIPE") throw error
  })
}

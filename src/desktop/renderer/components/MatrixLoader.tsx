/**
 * A round matrix loader, quieter than a spinner: 2px dots with the corners gone, a pulse orbiting
 * the rim around a steady centre.
 */
export function MatrixLoader({ title }: { title?: string }) {
  return (
    <span className="matrix" title={title} aria-hidden={!title}>
      {Array.from({ length: 16 }, (_, index) => {
        const turn = RIM.indexOf(index)
        return (
          <i
            key={index}
            style={
              CORNERS.has(index)
                ? { visibility: "hidden" }
                : turn < 0
                  ? { animation: "none" }
                  : { animationDelay: `${turn * 150}ms` }
            }
          />
        )
      })}
    </span>
  )
}

const CORNERS = new Set([0, 3, 12, 15])
/** The corner-less rim, clockwise from the top; each dot joins the 1.2 s cycle an eighth later. */
const RIM = [1, 2, 7, 11, 14, 13, 8, 4]

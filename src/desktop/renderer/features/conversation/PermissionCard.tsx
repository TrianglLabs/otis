import { Shield } from "lucide-react"
import { useId } from "react"
import type { PendingPermission } from "../../../contracts.js"
import { Button } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"

/**
 * Inline approval request pinned to the end of the transcript. Replies reference the request id, so a request that
 * was cancelled or superseded in the main process cannot be approved by a stale card.
 */
export function PermissionCard({
  permission,
  onRespond,
}: {
  permission: PendingPermission
  onRespond: (id: number, allow: boolean) => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const showLabel = permission.kind !== "shell" || permission.resources.length === 0

  return (
    <div className="permissionCard" role="alertdialog" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <div className="permissionCard-head">
        <span className="permissionCard-icon">
          <Icon icon={Shield} size={14} />
        </span>
        <div className="permissionCard-title" id={titleId}>
          Approval needed
        </div>
      </div>
      <div className="permissionCard-detail" id={descriptionId}>
        {showLabel ? <div className="permissionCard-label">{permission.label}</div> : null}
        {permission.resources.length > 0 ? (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable request details must be reachable by keyboard.
          <ul className="permissionCard-resources" aria-label="Requested resources" tabIndex={0}>
            {permission.resources.map((resource, index) => (
              <li key={`${index}:${resource}`}>
                <code>{resource}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="permissionCard-actions">
        <Button variant="outline" size="sm" onClick={() => onRespond(permission.id, false)}>
          Deny
        </Button>
        <Button variant="primary" size="sm" onClick={() => onRespond(permission.id, true)}>
          Allow once
        </Button>
      </div>
    </div>
  )
}

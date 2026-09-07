import { TriangleAlert } from "lucide-react"
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
  return (
    <div className="permissionCard" role="alertdialog" aria-label="Approval needed">
      <div className="permissionCard-head">
        <span className="permissionCard-icon">
          <Icon icon={TriangleAlert} size={14} />
        </span>
        <div className="permissionCard-text">
          <div className="permissionCard-title">Approval needed</div>
          <div className="permissionCard-label">{permission.label}</div>
          {permission.resources.length > 0 ? (
            <div className="permissionCard-resources">
              {permission.resources.map((resource) => (
                <code key={resource} title={resource}>
                  {resource}
                </code>
              ))}
            </div>
          ) : null}
        </div>
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

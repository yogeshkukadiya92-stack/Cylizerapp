import { activityIcons } from '../data/dashboard'
import type { RecentActivityItem } from '../types'

interface RecentActivityProps {
  activities: RecentActivityItem[]
}

export function RecentActivity({ activities }: RecentActivityProps) {
  return (
    <section className="panel recent-panel">
      <div className="panel-heading">
        <h2>Recent activity</h2>
        <button className="text-link" type="button">View all</button>
      </div>
      <div className="activity-feed">
        {activities.map((activity) => {
          const Icon = activityIcons[activity.kind]
          return (
            <article className="activity-feed__item" key={activity.id}>
              <div className={`activity-feed__icon activity-feed__icon--${activity.kind}`}><Icon size={16} /></div>
              <div className="activity-feed__copy">
                <strong>{activity.title}</strong>
                <span>{activity.detail}</span>
              </div>
              <time>{activity.time}</time>
            </article>
          )
        })}
        {activities.length === 0 ? <div className="panel-empty panel-empty--compact" role="status">No recent activity for this period.</div> : null}
      </div>
    </section>
  )
}

import { type ReactNode } from 'react';
import { Braces } from 'lucide-react';
import {
  Definition,
  StatusPill,
} from '../ui.js';

export function ReservedPage({ kind, icon, description, fields }: { kind: string; icon: ReactNode; description: string; fields: string[] }) {
  return (
    <section className="panel-grid settings-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            {icon}
            <div>
              <h2>{kind}</h2>
              <p>{description}</p>
            </div>
          </div>
          <StatusPill status="reserved" />
        </div>
        <div className="field-grid">
          {fields.map(field => (
            <div className="field-token" key={field}>
              <Braces size={14} />
              <span>{field}</span>
            </div>
          ))}
        </div>
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact"><h2>Initial Policy</h2></div>
        <div className="definition-list">
          <Definition term="phase 1" text="Read-only view." />
          <Definition term="write gate" text="Requires storage contract, validation, and event evidence." />
          <Definition term="audit" text="Every future mutation must link to task/session evidence." />
        </div>
      </aside>
    </section>
  );
}

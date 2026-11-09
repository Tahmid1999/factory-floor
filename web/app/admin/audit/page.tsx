'use client';

import { Input, Table } from 'antd';
import { useEffect, useState } from 'react';
import { AuditRow, hhmmss, usePoll } from '../../../lib/admin';
import { useAs } from '../useAs';
import { ViewState } from '../ViewState';

const json = (v: unknown) => (v === null || v === undefined ? '-' : JSON.stringify(v));

export default function AuditPage() {
  const { api } = useAs();
  const [text, setText] = useState('');
  const [action, setAction] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setAction(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const poll = usePoll<AuditRow[]>(api(action ? `/admin/audit?action=${encodeURIComponent(action)}` : '/admin/audit'));

  return (
    <>
      <div className="adm-bar">
        <Input
          size="small"
          allowClear
          placeholder="action, e.g. rate_change"
          style={{ maxWidth: 240 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="adm-mute">newest 100</span>
      </div>
      <ViewState poll={poll}>
        {(rows) => (
          <Table<AuditRow>
            size="small"
            pagination={false}
            rowKey="id"
            dataSource={rows}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: 'no audit rows' }}
            columns={[
              {
                title: 'at',
                dataIndex: 'at',
                render: (t: number) => <span className="mono">{`${new Date(t).toISOString().slice(0, 10)} ${hhmmss(t)}`}</span>,
              },
              { title: 'actor', dataIndex: 'actor' },
              { title: 'role', dataIndex: 'role' },
              { title: 'action', dataIndex: 'action', render: (a: string) => <span className="mono">{a}</span> },
              { title: 'entity', dataIndex: 'entity', render: (e: string) => <span className="mono">{e}</span> },
              { title: 'before', dataIndex: 'before', render: (v: unknown) => <span className="mono">{json(v)}</span> },
              { title: 'after', dataIndex: 'after', render: (v: unknown) => <span className="mono">{json(v)}</span> },
            ]}
          />
        )}
      </ViewState>
    </>
  );
}

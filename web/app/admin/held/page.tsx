'use client';

import { Table } from 'antd';
import Link from 'next/link';
import { HeldRow, hhmmss, usePoll } from '../../../lib/admin';
import { attrs } from '../attrs';
import { useAs } from '../useAs';
import { ViewState } from '../ViewState';

function age(sec: number): string {
  if (sec < 120) return `${sec} s`;
  if (sec < 7200) return `${Math.floor(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h`;
}

export default function HeldPage() {
  const { api, href } = useAs();
  const poll = usePoll<HeldRow[]>(api('/admin/held'));

  return (
    <ViewState poll={poll}>
      {(rows) => (
        <Table<HeldRow>
          size="small"
          pagination={false}
          rowKey={(r) => `${r.code}:${r.op}:${r.heldAt}`}
          dataSource={rows}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: 'nothing held' }}
          rowClassName={(r) => (r.stuck ? 'gate-row' : '')}
          onRow={(r) => attrs({ 'data-row': r.code ?? '' })}
          columns={[
            {
              title: 'bundle',
              dataIndex: 'code',
              render: (c: string | null) =>
                c ? (
                  <Link className="mono" href={href(`/admin/bundles/${c}`)}>
                    {c}
                  </Link>
                ) : (
                  '-'
                ),
            },
            { title: 'op', dataIndex: 'op', render: (o: string | null) => o ?? '-' },
            { title: 'device', dataIndex: 'device', render: (d: string | null) => <span className="mono">{d ?? '-'}</span> },
            { title: 'held at', dataIndex: 'heldAt', render: (t: number) => <span className="mono">{hhmmss(t)}</span> },
            { title: 'age', dataIndex: 'ageSec', align: 'right', render: (s: number) => <span className="mono">{age(s)}</span> },
            { title: '', dataIndex: 'stuck', render: (s: boolean) => (s ? <span className="adm-warn">stuck</span> : null) },
          ]}
        />
      )}
    </ViewState>
  );
}

'use client';

import { Drawer, Input, Table } from 'antd';
import { useState } from 'react';
import { PayrollRow, PayrollScan, todayUtc, usePoll, utcTime } from '../../../lib/admin';
import { money } from '../../../lib/money';
import { attrs } from '../attrs';
import { useAs } from '../useAs';
import { ViewState } from '../ViewState';

export default function PayrollPage() {
  const { api } = useAs();
  const [typed, setTyped] = useState(todayUtc());
  const [who, setWho] = useState<PayrollRow | null>(null);
  // A half-typed date is not a day; the API would answer 400 and stop the poll.
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(typed) && !Number.isNaN(Date.parse(typed));
  const day = valid ? typed : todayUtc();
  const poll = usePoll<{ day: string; rows: PayrollRow[] }>(api(`/admin/payroll?day=${day}`));

  return (
    <>
      <div className="adm-bar">
        <span>
          <label htmlFor="pay-day" className="adm-mute" style={{ marginRight: 6 }}>
            day
          </label>
          <Input id="pay-day" size="small" type="date" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ width: 150 }} />
        </span>
        <span className="adm-mute">UTC day</span>
      </div>
      <ViewState poll={poll}>
        {({ rows }) => (
          <Table<PayrollRow>
            size="small"
            pagination={false}
            rowKey="key"
            dataSource={rows}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: 'no scans this day' }}
            rowClassName={() => 'click-row'}
            onRow={(r) => ({ ...attrs({ 'data-row': r.key }), onClick: () => setWho(r) })}
            columns={[
              {
                title: 'worker',
                dataIndex: 'worker',
                render: (w: string, r) => (
                  <>
                    {w} {r.kind === 'sim' && <span className="mono adm-mute">sim</span>}
                  </>
                ),
              },
              { title: 'pieces', dataIndex: 'pieces', align: 'right', render: (n: number) => <span className="mono">{n}</span> },
              { title: 'paid pieces', dataIndex: 'paidPieces', align: 'right', render: (n: number) => <span className="mono">{n}</span> },
              { title: 'earned', dataIndex: 'earningsMills', align: 'right', render: (m: number) => <span className="mono">{money(m)}</span> },
            ]}
          />
        )}
      </ViewState>
      <Drawer open={!!who} onClose={() => setWho(null)} width={520} title={who ? `${who.worker} · ${day}` : ''} destroyOnHidden>
        {who && <Scans day={day} workerKey={who.key} />}
      </Drawer>
    </>
  );
}

function Scans({ day, workerKey }: { day: string; workerKey: string }) {
  const { api } = useAs();
  const poll = usePoll<{ day: string; rows: PayrollScan[] }>(
    api(`/admin/payroll/scans?day=${day}&worker=${encodeURIComponent(workerKey)}`),
  );
  return (
    <ViewState poll={poll}>
      {({ rows }) => (
        <Table<PayrollScan>
          size="small"
          pagination={false}
          rowKey={(s) => `${s.at}:${s.bundleCode}:${s.op}:${s.round}`}
          dataSource={rows}
          locale={{ emptyText: 'no scans' }}
          columns={[
            { title: 'at', dataIndex: 'at', render: (t: string) => <span className="mono">{utcTime(Date.parse(t))}</span> },
            { title: 'bundle', dataIndex: 'bundleCode', render: (c: string) => <span className="mono">{c}</span> },
            { title: 'op', dataIndex: 'op' },
            { title: 'round', dataIndex: 'round', align: 'right', render: (n: number) => <span className="mono">{n}</span> },
            { title: 'pieces', dataIndex: 'pieces', align: 'right', render: (n: number) => <span className="mono">{n}</span> },
            { title: 'earned', dataIndex: 'mills', align: 'right', render: (m: number) => <span className="mono">{m > 0 ? money(m) : '-'}</span> },
          ]}
        />
      )}
    </ViewState>
  );
}

'use client';

import { Button, InputNumber, Select, Table } from 'antd';
import { useState } from 'react';
import { StockMovement, StockRoll, StressResult, adminCall, hhmmss, usePoll } from '../../../lib/admin';
import { money } from '../../../lib/money';
import { attrs } from '../attrs';
import { useAdminSession } from '../session';
import { useAs } from '../useAs';
import { ViewState } from '../ViewState';

const metres = (cm: number) => `${(cm / 100).toFixed(1)} m`;
const REASONS = ['count', 'damaged', 'found'] as const;

export default function StockPage() {
  const { api } = useAs();
  const poll = usePoll<StockRoll[]>(api('/admin/stock'));
  const { session } = useAdminSession();
  const [open, setOpen] = useState<string | null>(null);
  const [stress, setStress] = useState('');
  const [busy, setBusy] = useState(false);

  const press = async () => {
    setBusy(true);
    try {
      const r = await adminCall<StressResult>('/admin/stock/stress', { method: 'POST' });
      setStress(
        `${r.accepted + r.refused} issues at once on ${r.roll} · ${r.accepted} taken · ${r.refused} refused · on hand ${metres(r.onHandCm)} · ${r.ms} ms`,
      );
      setOpen(r.roll);
    } catch (e) {
      setStress(e instanceof Error ? e.message : 'failed');
    }
    setBusy(false);
  };

  return (
    <>
      <div className="adm-bar">
        <span>
          <Button size="small" loading={busy} onClick={press}>
            Try breaking it
          </Button>{' '}
          <span className="mono" data-testid="stress-result">
            {stress}
          </span>
        </span>
        <span className="adm-mute">newest 100 rolls</span>
      </div>
      <ViewState poll={poll}>
        {(rolls) => (
          <>
            <Table<StockRoll>
              size="small"
              pagination={false}
              rowKey="code"
              dataSource={rolls}
              scroll={{ x: 'max-content' }}
              locale={{ emptyText: 'no rolls' }}
              rowClassName={() => 'click-row'}
              onRow={(r) => ({ ...attrs({ 'data-row': r.code }), onClick: () => setOpen(r.code) })}
              columns={[
                {
                  title: 'roll',
                  dataIndex: 'code',
                  render: (c: string, r) => (
                    <>
                      <span className="mono">{c}</span> {r.isSimulated && <span className="mono adm-mute">sim</span>}
                    </>
                  ),
                },
                {
                  title: 'received',
                  dataIndex: 'receivedAt',
                  render: (t: number) => <span className="mono">{new Date(t).toISOString().slice(0, 16).replace('T', ' ')}</span>,
                },
                {
                  title: 'cost / m',
                  dataIndex: 'costPerMetreMills',
                  align: 'right',
                  render: (m: number) => <span className="mono">{money(m)}</span>,
                },
                {
                  title: 'on hand',
                  dataIndex: 'onHandCm',
                  align: 'right',
                  onCell: () => attrs({ 'data-col': 'onhand' }),
                  render: (cm: number) => <span className="mono">{metres(cm)}</span>,
                },
              ]}
            />
            {open && <Movements code={open} />}
            {session && <Adjust rolls={rolls.map((r) => r.code)} />}
          </>
        )}
      </ViewState>
    </>
  );
}

function Movements({ code }: { code: string }) {
  const { api } = useAs();
  const poll = usePoll<StockMovement[]>(api(`/admin/stock/${encodeURIComponent(code)}/movements`));
  return (
    <div style={{ marginTop: 14 }} data-testid="movements">
      <div className="adm-bar">
        <b className="mono">{code}</b>
        <span className="adm-mute">movements</span>
      </div>
      <ViewState poll={poll}>
        {(rows) => (
          <Table<StockMovement>
            size="small"
            pagination={{ pageSize: 20, hideOnSinglePage: true, size: 'small' }}
            rowKey={(m) => `${m.at}:${m.kind}:${m.bundleCode}:${m.deltaCm}`}
            dataSource={rows}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: 'at', dataIndex: 'at', render: (t: number) => <span className="mono">{hhmmss(t)}</span> },
              { title: 'kind', dataIndex: 'kind' },
              {
                title: 'cm',
                dataIndex: 'deltaCm',
                align: 'right',
                render: (d: number) => <span className="mono">{d > 0 ? `+${d}` : d}</span>,
              },
              { title: 'bundle', dataIndex: 'bundleCode', render: (b: string | null) => <span className="mono">{b ?? '-'}</span> },
              {
                title: 'actor',
                dataIndex: 'actor',
                render: (a: string, m) => (
                  <>
                    {a} {m.isSimulated && <span className="mono adm-mute">sim</span>}
                  </>
                ),
              },
              { title: 'reason', dataIndex: 'reason', render: (r: string | null) => r ?? '-' },
            ]}
          />
        )}
      </ViewState>
    </div>
  );
}

// Login only; the API refuses it without the owner's cookie anyway.
function Adjust({ rolls }: { rolls: string[] }) {
  const [roll, setRoll] = useState(rolls[0]);
  const [cm, setCm] = useState<number | null>(null);
  const [reason, setReason] = useState<(typeof REASONS)[number]>('count');
  const [note, setNote] = useState('');

  const send = async () => {
    try {
      const r = await adminCall<{ rollCode: string; onHandCm: number; amountMills: number }>('/admin/stock/adjust', {
        method: 'POST',
        body: JSON.stringify({ rollCode: roll, deltaCm: cm, reason }),
      });
      setNote(`${r.rollCode} on hand ${metres(r.onHandCm)}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'failed');
    }
  };

  return (
    <div className="adm-write">
      <Select size="small" showSearch value={roll} onChange={setRoll} style={{ width: 120 }} options={rolls.map((c) => ({ value: c, label: c }))} />
      <InputNumber size="small" precision={0} value={cm} onChange={setCm} placeholder="delta cm" />
      <Select size="small" value={reason} onChange={setReason} style={{ width: 100 }} options={REASONS.map((r) => ({ value: r, label: r }))} />
      <Button size="small" disabled={!roll || !cm} onClick={send}>
        Adjust
      </Button>
      <span className="mono adm-mute">{note}</span>
    </div>
  );
}

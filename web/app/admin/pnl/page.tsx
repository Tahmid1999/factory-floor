'use client';

import { Button, Drawer, Popconfirm, Select, Switch, Table } from 'antd';
import { useState } from 'react';
import { PeriodRow, PostingRow, Pnl, adminCall, monthName, thisPeriod, usePoll, utcStamp } from '../../../lib/admin';
import { money } from '../../../lib/money';
import { attrs } from '../attrs';
import { useAdminSession } from '../session';
import { useAs } from '../useAs';
import { ViewState } from '../ViewState';

type Line = { key: string; label: string; mills: number; kind?: string; late?: string; memo?: boolean; total?: boolean };

// Costs read as negatives so the column adds up top to bottom.
const signed = (mills: number) => (mills < 0 ? `-${money(-mills)}` : money(mills));

function linesOf(p: Pnl): Line[] {
  return [
    { key: 'revenue', label: 'revenue', mills: p.revenue, kind: 'revenue' },
    { key: 'fabric', label: 'fabric', mills: -p.fabric, kind: 'fabric' },
    { key: 'trims', label: 'trims', mills: -p.trims, kind: 'trims' },
    { key: 'labour', label: 'labour', mills: -p.labour, kind: 'labour' },
    { key: 'adjustment', label: 'stock adjustments', mills: -p.adjustment, kind: 'adjustment' },
    ...p.late.map((l) => ({ key: `late-${l.from}`, label: `late scans from ${monthName(l.from)}`, mills: l.mills, late: l.from })),
    { key: 'contribution', label: 'contribution', mills: p.contribution, total: true },
    { key: 'writeoff', label: 'scrap write-off (memo)', mills: p.writeoff, kind: 'writeoff', memo: true },
    { key: 'wip', label: `WIP at ${p.closed ? 'close' : 'now'} (memo)`, mills: p.wip.mills, memo: true },
  ];
}

export default function PnlPage() {
  const { api } = useAs();
  const { session } = useAdminSession();
  const [chosen, setChosen] = useState<string | null>(null);
  const [excludeSim, setExcludeSim] = useState(false);
  const [open, setOpen] = useState<Line | null>(null);
  const [note, setNote] = useState('');

  const periods = usePoll<PeriodRow[]>(api('/admin/pnl/periods'));

  return (
    <ViewState poll={periods}>
      {(list) => {
        const period = chosen ?? list[0]?.period ?? thisPeriod();
        const over = period < thisPeriod();
        const isClosed = list.find((p) => p.period === period)?.closed ?? false;
        const close = async () => {
          try {
            await adminCall('/admin/close', { method: 'POST', body: JSON.stringify({ period }) });
            setNote(`${monthName(period)} closed`);
          } catch (e) {
            setNote(e instanceof Error ? e.message : 'failed');
          }
        };
        return (
          <>
            <div className="adm-bar">
              <span>
                <Select
                  size="small"
                  aria-label="period"
                  value={period}
                  onChange={setChosen}
                  style={{ width: 130 }}
                  options={list.map((p) => ({ value: p.period, label: `${p.period}${p.closed ? ' · closed' : ''}` }))}
                />{' '}
                <Switch size="small" checked={excludeSim} onChange={setExcludeSim} aria-label="exclude simulated" />{' '}
                <span className="adm-mute">exclude simulated</span>
              </span>
              <span>
                {session && over && !isClosed && (
                  <Popconfirm title={`Close ${monthName(period)}? It cannot be reopened.`} okText="Close" onConfirm={close}>
                    <Button size="small" danger>
                      Close {monthName(period)}
                    </Button>
                  </Popconfirm>
                )}{' '}
                <span className="mono adm-mute">{note}</span>
              </span>
            </div>
            <Month period={period} excludeSim={excludeSim} onOpen={setOpen} />
            <Drawer
              open={!!open}
              onClose={() => setOpen(null)}
              width={720}
              title={open ? `${open.label} · ${period}` : ''}
              destroyOnHidden
            >
              {open && <Postings period={period} excludeSim={excludeSim} line={open} />}
            </Drawer>
          </>
        );
      }}
    </ViewState>
  );
}

function Month({ period, excludeSim, onOpen }: { period: string; excludeSim: boolean; onOpen: (l: Line) => void }) {
  const { api } = useAs();
  const poll = usePoll<Pnl>(api(`/admin/pnl?period=${period}${excludeSim ? '&excludeSim=1' : ''}`));
  return (
    <ViewState poll={poll}>
      {(p) => (
        <>
          {p.closed && (
            <div className="mono adm-mute" data-testid="closed-note" style={{ marginBottom: 6 }}>
              closed {utcStamp(p.closed.closedAt)} · by {p.closed.closedBy}
            </div>
          )}
          <Table<Line>
            size="small"
            pagination={false}
            showHeader={false}
            rowKey="key"
            dataSource={linesOf(p)}
            style={{ maxWidth: 520 }}
            rowClassName={(l) => [l.kind || l.late ? 'click-row' : '', l.key === 'writeoff' ? 'memo-first' : ''].join(' ')}
            onRow={(l) => ({
              ...attrs({ 'data-row': l.key, ...(l.memo || l.total ? {} : { 'data-line': '1' }) }),
              onClick: l.kind || l.late ? () => onOpen(l) : undefined,
            })}
            columns={[
              { dataIndex: 'label', render: (t: string, l) => (l.total ? <b>{t}</b> : <span className={l.memo ? 'adm-mute' : undefined}>{t}</span>) },
              {
                dataIndex: 'mills',
                align: 'right',
                render: (m: number, l) => (
                  <span className={`mono${l.memo ? ' adm-mute' : ''}`} data-mills={m}>
                    {signed(m)}
                  </span>
                ),
              },
            ]}
          />
        </>
      )}
    </ViewState>
  );
}

function Postings({ period, excludeSim, line }: { period: string; excludeSim: boolean; line: Line }) {
  const { api } = useAs();
  const q = `period=${period}${line.kind ? `&kind=${line.kind}` : ''}${line.late ? '&late=1' : ''}${excludeSim ? '&excludeSim=1' : ''}`;
  const poll = usePoll<{ rows: PostingRow[]; next: string | null }>(api(`/admin/pnl/postings?${q}`));
  const [more, setMore] = useState<PostingRow[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [err, setErr] = useState('');

  // The polled first page refreshes under the pages already loaded; paging
  // continues from the last row we hold, not from the poll's own cursor.
  const cursor = next === undefined ? (poll.data?.next ?? null) : next;
  const loadMore = async () => {
    const after = more.length ? more[more.length - 1].id : poll.data?.rows[poll.data.rows.length - 1]?.id;
    if (!after) return;
    try {
      const r = await adminCall<{ rows: PostingRow[]; next: string | null }>(api(`/admin/pnl/postings?${q}&after=${after}`));
      setMore((m) => [...m, ...r.rows]);
      setNext(r.next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  };

  return (
    <ViewState poll={poll}>
      {(first) => (
        <>
          <Table<PostingRow>
            size="small"
            pagination={false}
            rowKey="id"
            dataSource={[...first.rows, ...more]}
            locale={{ emptyText: 'no postings' }}
            columns={[
              { title: 'at', dataIndex: 'at', render: (t: string) => <span className="mono">{utcStamp(t)}</span> },
              { title: 'kind', dataIndex: 'kind' },
              { title: 'bundle', dataIndex: 'bundleCode', render: (c: string | null) => <span className="mono">{c ?? '-'}</span> },
              { title: 'op', dataIndex: 'op', render: (o: string | null) => o ?? '-' },
              {
                title: 'device',
                dataIndex: 'device',
                render: (d: string | null, r) => (
                  <>
                    <span className="mono">{d ?? '-'}</span> {r.isSimulated && <span className="mono adm-mute">sim</span>}
                  </>
                ),
              },
              { title: 'amount', dataIndex: 'amountMills', align: 'right', render: (m: number) => <span className="mono">{money(m)}</span> },
            ]}
          />
          {cursor && (
            <Button size="small" style={{ marginTop: 8 }} onClick={loadMore}>
              More
            </Button>
          )}
          {err && <span className="mono adm-bad"> {err}</span>}
        </>
      )}
    </ViewState>
  );
}

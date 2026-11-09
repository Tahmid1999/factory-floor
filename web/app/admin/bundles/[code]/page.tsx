'use client';

import { Table } from 'antd';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { BundleDetail, TimelineRow, hhmmss, usePoll } from '../../../../lib/admin';
import { money } from '../../../../lib/money';
import { attrs } from '../../attrs';
import { useAs } from '../../useAs';
import { ViewState } from '../../ViewState';

// What happened to the row after it arrived, as short words.
function flags(r: TimelineRow) {
  const out: { text: string; cls: string }[] = [];
  if (r.held) out.push({ text: 'held', cls: 'adm-warn' });
  if (r.released) out.push({ text: 'released', cls: 'adm-warn' });
  if (r.wasted) out.push({ text: 'wasted', cls: 'adm-bad' });
  if (r.round) out.push({ text: `round ${r.round}`, cls: '' });
  return out;
}

export default function BundlePage() {
  const { code } = useParams<{ code: string }>();
  const { api, href } = useAs();
  const poll = usePoll<BundleDetail>(api(`/admin/bundles/${encodeURIComponent(code)}`));

  return (
    <ViewState poll={poll}>
      {(b) => (
        <>
          <div className="adm-bar">
            <span>
              <Link href={href('/admin/bundles')}>Bundles</Link> / <b className="mono">{b.code}</b>
            </span>
            <span className="mono adm-mute">
              {b.status} · next {b.nextOp ?? '-'} · round {b.round} · {b.owner}
              {b.wastedMills > 0 && <span className="adm-bad"> · wasted {money(b.wastedMills)}</span>}
            </span>
          </div>
          <Table<TimelineRow>
            size="small"
            pagination={false}
            rowKey={(r) => `${r.source}:${r.op}:${r.correctedAt}:${r.seq ?? ''}`}
            dataSource={b.events}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: 'no scans yet' }}
            onRow={(r) => attrs({ 'data-row': r.op })}
            columns={[
              { title: 'time', dataIndex: 'correctedAt', render: (t: number) => <span className="mono">{hhmmss(t, true)}</span> },
              { title: 'op', dataIndex: 'op' },
              { title: 'source', dataIndex: 'source' },
              {
                title: 'device',
                render: (_: unknown, r) =>
                  r.device ? (
                    <span className="mono">
                      {r.device}
                      {r.deviceKind === 'sim' && <span className="adm-mute"> sim</span>}
                    </span>
                  ) : (
                    '-'
                  ),
              },
              { title: 'seq', dataIndex: 'seq', align: 'right', render: (s: number | null) => <span className="mono">{s ?? '-'}</span> },
              { title: 'scanned', dataIndex: 'scannedAt', render: (t: number | null) => <span className="mono">{hhmmss(t, true)}</span> },
              { title: 'received', dataIndex: 'receivedAt', render: (t: number) => <span className="mono">{hhmmss(t, true)}</span> },
              { title: 'result', dataIndex: 'result' },
              {
                title: 'flags',
                render: (_: unknown, r) =>
                  flags(r).map((f, i) => (
                    <span key={f.text} className={f.cls}>
                      {i > 0 && ', '}
                      {f.text}
                    </span>
                  )),
              },
              {
                title: 'posted',
                dataIndex: 'postedMills',
                align: 'right',
                render: (m: number) => <span className="mono">{m > 0 ? money(m) : '-'}</span>,
              },
            ]}
          />
        </>
      )}
    </ViewState>
  );
}

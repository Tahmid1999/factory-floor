'use client';

import { Input, Table } from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BundleRow, usePoll } from '../../../lib/admin';
import { money } from '../../../lib/money';
import { attrs } from '../attrs';
import { useAs } from '../useAs';
import { ViewState } from '../ViewState';

export default function BundlesPage() {
  const { api, href } = useAs();
  const router = useRouter();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  // The poll restarts on every new path, so typing waits for a pause.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const poll = usePoll<BundleRow[]>(api(q ? `/admin/bundles?q=${encodeURIComponent(q)}` : '/admin/bundles'));

  return (
    <>
      <div className="adm-bar">
        <Input.Search
          size="small"
          allowClear
          placeholder="bundle code"
          style={{ maxWidth: 240 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="adm-mute">newest 50</span>
      </div>
      <ViewState poll={poll}>
        {(rows) => (
          <Table<BundleRow>
            size="small"
            pagination={false}
            rowKey="code"
            dataSource={rows}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: 'no bundles' }}
            rowClassName={() => 'click-row'}
            onRow={(r) => ({
              ...attrs({ 'data-row': r.code }),
              onClick: () => router.push(href(`/admin/bundles/${r.code}`)),
            })}
            columns={[
              { title: 'bundle', dataIndex: 'code', render: (c: string) => <span className="mono">{c}</span> },
              { title: 'status', dataIndex: 'status' },
              { title: 'next op', dataIndex: 'nextOp', render: (o: string | null) => o ?? '-' },
              { title: 'round', dataIndex: 'round', align: 'right' },
              { title: 'owner', dataIndex: 'owner' },
              {
                title: 'wasted',
                dataIndex: 'wastedMills',
                align: 'right',
                render: (m: number) =>
                  m > 0 ? <span className="mono adm-bad">{money(m)}</span> : <span className="adm-mute">-</span>,
              },
            ]}
          />
        )}
      </ViewState>
    </>
  );
}

'use client';

import { Table } from 'antd';
import { StationRow, hhmmss, usePoll } from '../../../lib/admin';
import { attrs } from '../attrs';
import { useAs } from '../useAs';
import { ViewState } from '../ViewState';

const mono = (v: string | number) => <span className="mono">{v}</span>;

export default function StationsPage() {
  const { api } = useAs();
  const poll = usePoll<StationRow[]>(api('/admin/stations'));

  return (
    <ViewState poll={poll}>
      {(rows) => (
        <Table<StationRow>
          size="small"
          pagination={false}
          rowKey={(r, i) => `${r.device}:${i}`}
          dataSource={rows}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: 'no devices' }}
          onRow={(r) => attrs({ 'data-row': r.device })}
          columns={[
            { title: 'device', dataIndex: 'device', render: mono },
            { title: 'kind', dataIndex: 'kind' },
            { title: 'who', render: (_: unknown, r) => r.guest ?? r.simName ?? '-' },
            { title: 'last sync', dataIndex: 'lastSyncAt', render: (t: number | null) => mono(hhmmss(t)) },
            { title: 'pending', dataIndex: 'lastPending', align: 'right', render: mono },
            { title: 'clock offset', dataIndex: 'clockOffsetMs', align: 'right', render: (ms: number) => mono(`${ms} ms`) },
            {
              title: 'quiet for',
              dataIndex: 'offlineFor',
              align: 'right',
              render: (s: number | null) => mono(s === null ? '-' : `${s} s`),
            },
          ]}
        />
      )}
    </ViewState>
  );
}

'use client';

import { Button, InputNumber, Popconfirm, Select, Table } from 'antd';
import { useState } from 'react';
import { Floor, adminCall, rate, usePoll } from '../../lib/admin';
import { attrs } from './attrs';
import { useAdminSession } from './session';
import { useAs } from './useAs';
import { ViewState } from './ViewState';

type Op = Floor['ops'][number];

const mono = (n: number) => <span className="mono">{n}</span>;

export default function FloorPage() {
  const { api } = useAs();
  const poll = usePoll<Floor>(api('/admin/floor'));
  const { session } = useAdminSession();

  return (
    <ViewState poll={poll}>
      {(floor) => (
        <>
          <div className="adm-bar">
            <b>Line 2 · style 944 · polo</b>
            <span className="mono adm-mute" data-testid="sim-line">
              sim line {floor.simOn ? 'on' : 'off'} · {floor.visitors} {floor.visitors === 1 ? 'visitor' : 'visitors'}
            </span>
          </div>
          <Table<Op>
            size="small"
            pagination={false}
            rowKey="op"
            dataSource={floor.ops}
            scroll={{ x: 'max-content' }}
            rowClassName={(r) => (r.gate ? 'gate-row' : '')}
            onRow={(r) => attrs({ 'data-row': r.op, 'data-gate': String(r.gate) })}
            columns={[
              { title: 'op', dataIndex: 'op' },
              { title: 'waiting', dataIndex: 'waiting', align: 'right', render: mono },
              { title: 'done today', dataIndex: 'doneToday', align: 'right', render: mono },
              {
                title: 'rate',
                dataIndex: 'rateMills',
                align: 'right',
                onCell: () => attrs({ 'data-col': 'rate' }),
                render: (m: number) => <span className="mono">{rate(m)}</span>,
              },
            ]}
          />
          <div className="mono adm-tail">
            {floor.tail.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          {session?.role === 'admin' && <Writes ops={floor.ops.filter((o) => o.rateMills > 0)} />}
        </>
      )}
    </ViewState>
  );
}

// The two writes. They only show with the owner's cookie; the API refuses them
// without it anyway.
function Writes({ ops }: { ops: Op[] }) {
  const [op, setOp] = useState(ops[0]?.op);
  const [mills, setMills] = useState<number | null>(null);
  const [note, setNote] = useState('');

  const run = async (what: () => Promise<unknown>, done: string) => {
    try {
      await what();
      setNote(done);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'failed');
    }
  };

  return (
    <div className="adm-write">
      <Select
        size="small"
        value={op}
        onChange={setOp}
        style={{ width: 120 }}
        options={ops.map((o) => ({ value: o.op, label: o.op }))}
      />
      <InputNumber size="small" min={1} precision={0} value={mills} onChange={setMills} placeholder="mills / pc" />
      <Button
        size="small"
        disabled={!op || !mills}
        onClick={() => {
          // A minute ahead, so it cannot tie with a rate already starting now
          // and nothing already posted is repriced.
          const effective = new Date(Date.now() + 60_000);
          return run(
            () =>
              adminCall('/admin/rates', {
                method: 'POST',
                body: JSON.stringify({ op, ratePerPieceMills: mills, effectiveFrom: effective.toISOString() }),
              }),
            `${op} ${mills} mills from ${effective.toLocaleTimeString('en-GB')}`,
          );
        }}
      >
        Set rate
      </Button>
      <Popconfirm
        title="Delete guest data and this month's simulated rows?"
        okText="Reset"
        onConfirm={() => run(() => adminCall('/admin/reset', { method: 'POST' }), 'reset done')}
      >
        <Button size="small" danger>
          Reset demo
        </Button>
      </Popconfirm>
      <span className="mono adm-mute">{note}</span>
    </div>
  );
}

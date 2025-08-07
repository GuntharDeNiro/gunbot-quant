/* eslint react/prop-types: 0 */
import { memo, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Collapse,
  Code,
  Divider,
  Grid,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip as MantineTooltip,
  UnstyledButton,
  useMantineTheme,
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import dayjs from 'dayjs';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChartPie3,
  IconBox,
  IconPlus,
  IconInfoCircle,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';

/* ---------------------------------------------------------------------------
   Color mapping for Exit Reasons Pie Chart
--------------------------------------------------------------------------- */
const REASON_COLORS = {
  'Stop Loss': '#fa5252',
  'Take Profit': '#40c057',
  'Signal Cross': '#228be6',
  'Death Cross (EMA)': '#be4bdb',
  'MACD Cross Down': '#be4bdb',
  'Supertrend flip': '#fd7e14',
  'HA candle flipped red': '#fd7e14',
  'Crossed middle band': '#845ef7',
  'Price fell to middle BB': '#845ef7',
  'RSI Overbought': '#15aabf',
  'RSI exit level': '#15aabf',
  'Stoch Overbought': '#15aabf',
  'Gunbot Trade': '#3498db'
};
const PIE_COLORS = [
  '#3498db',
  '#e74c3c',
  '#9b59b6',
  '#f1c40f',
  '#2ecc71',
  '#1abc9c',
  '#e67e22',
];

/* ---------------------------------------------------------------------------
   Stat Tile
--------------------------------------------------------------------------- */
const StatTile = memo(({ label, value, color, suffix = '', size = 'lg' }) => (
  <Paper
    withBorder
    p="xs"
    radius="md"
    style={{ background: 'transparent', borderColor: '#2a2a2a' }}
  >
    <Text size="xs" c="dimmed">
      {label}
    </Text>
    <Text size={size} c={color} fw={600}>
      {typeof value === 'number' && !Number.isNaN(value)
        ? value.toFixed(2)
        : '--'}
      {suffix}
    </Text>
  </Paper>
));
StatTile.displayName = 'StatTile';

/* ---------------------------------------------------------------------------
   Equity Chart
--------------------------------------------------------------------------- */
const EquityChart = memo(({ data, theme }) => {
  const { strategy, buy_and_hold } = data || {};

  if ((!strategy || strategy.length < 2) && (!buy_and_hold || buy_and_hold.length < 2)) {
    return (
      <Center h={350}>
        <Stack align="center" gap="xs">
          <IconAlertTriangle size={32} color={theme.colors.gray[6]} />
          <Text c="dimmed">Not enough data to render chart.</Text>
        </Stack>
      </Center>
    );
  }

  const combinedData = useMemo(() => {
    if (!strategy && !buy_and_hold) return [];

    const strategyDates = strategy?.map(d => d.date) || [];
    const bhDates = buy_and_hold?.map(d => d.date) || [];
    const allDates = [...new Set([...strategyDates, ...bhDates])].sort();

    const strategyMap = new Map(strategy?.map((d) => [d.date, d.value]) || []);
    const bhMap = new Map(buy_and_hold?.map((d) => [d.date, d.value]) || []);

    return allDates.map(date => ({
      date: date,
      equity_strategy: strategyMap.get(date),
      equity_buy_and_hold: bhMap.get(date),
    }));
  }, [strategy, buy_and_hold]);


  return (
    <ResponsiveContainer width="100%" height={350}>
      <AreaChart
        data={combinedData}
        margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
      >
        <defs>
          <linearGradient id="colorStrategy" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={theme.colors.green[5]} stopOpacity={0.8} />
            <stop offset="95%" stopColor={theme.colors.green[5]} stopOpacity={0.1} />
          </linearGradient>
          <linearGradient id="colorBH" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={theme.colors.gray[6]} stopOpacity={0.4} />
            <stop offset="95%" stopColor={theme.colors.gray[6]} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.colors.dark[3]} />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => dayjs(d).format('MMM D')}
          tick={{ fill: theme.colors.gray[5], fontSize: 12 }}
          stroke={theme.colors.dark[3]}
        />
        <YAxis
          tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
          domain={['dataMin', 'auto']}
          allowDataOverflow={false}
          tick={{ fill: theme.colors.gray[5], fontSize: 12 }}
          stroke={theme.colors.dark[3]}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: theme.colors.dark[6],
            borderColor: theme.colors.dark[3],
            borderRadius: theme.radius.md,
          }}
          labelFormatter={(l) => dayjs(l).format('dddd, MMMM D, YYYY')}
          formatter={(value, name) => [
            `$${value?.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) ?? 'N/A'}`,
            name === 'equity_strategy' ? 'Strategy' : 'Buy & Hold',
          ]}
        />
        
        <Area
          type="monotone"
          dataKey="equity_buy_and_hold"
          stroke={theme.colors.gray[5]}
          strokeWidth={1.5}
          fillOpacity={1}
          fill="url(#colorBH)"
          isAnimationActive={false}
          connectNulls
        />

        <Area
          type="monotone"
          dataKey="equity_strategy"
          stroke={theme.colors.green[4]}
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#colorStrategy)"
          isAnimationActive={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});
EquityChart.displayName = 'EquityChart';

const fetchGunbotStatus = async () => {
    const res = await fetch('/api/v1/gunbot/status');
    if (!res.ok) throw new Error('Network response was not ok');
    return res.json();
};

/* ---------------------------------------------------------------------------
   Main Component
--------------------------------------------------------------------------- */
export default function ResultsDisplay({ report, onAddPair }) {
  const theme = useMantineTheme();
  const [selectedTestId, setSelectedTestId] = useState(null);
  const [analyticsExpanded, setAnalyticsExpanded] = useState(true);
  const [expandedRecordIds, setExpandedRecordIds] = useState([]);
  const [sortStatus, setSortStatus] = useState({
    columnAccessor: 'is_active_pair',
    direction: 'desc',
  });

  const { data: gunbotStatus } = useQuery({ queryKey: ['gunbotStatus'], queryFn: fetchGunbotStatus });
  const isGunbotConnected = gunbotStatus?.connected === true;

  if (!report || !report.overall_stats || !report.individual_tests) {
    return (
      <Alert icon={<IconAlertTriangle />} title="Report Empty" color="blue">
        The selected report does not contain valid backtest data.
      </Alert>
    );
  }

  const { activeData, testName, isOverallView } = useMemo(() => {
    const overall = {
      stats: report.overall_stats,
      equityCurve: report.overall_equity_curve,
      params: null,
    };

    if (selectedTestId === null) {
      return {
        activeData: overall,
        testName: 'Portfolio Overview',
        isOverallView: true,
      };
    }

    const test = report.individual_tests.find((t) => t.test_id === selectedTestId);
    return {
      activeData: test
        ? { stats: test.stats, equityCurve: test.equity_curve, params: test.parameters }
        : overall,
      testName: test
        ? `${test.strategy_name} on ${test.symbol}`
        : 'Portfolio Overview',
      isOverallView: !test,
    };
  }, [report, selectedTestId]);

  const { stats, params } = activeData;
  const hasParams = params && Object.keys(params).length > 0;
  const exitReasons = stats['Exit Reason Counts'] || {};
  const hasExitData = Object.keys(exitReasons).length > 0;

  const pieData = useMemo(
    () =>
      Object.entries(exitReasons).map(([name, value], index) => ({
        name,
        value,
        fill: REASON_COLORS[name] || PIE_COLORS[index % PIE_COLORS.length],
      })),
    [exitReasons],
  );

  const testsForTable = useMemo(() => {
    const data = report.individual_tests.map((t) => ({
      ...t.stats,
      test_id: t.test_id,
      Strategy: t.strategy_name,
      Symbol: t.symbol,
      Timeframe: t.timeframe,
      is_active_pair: t.is_active_pair,
      parameters: t.parameters,
      // Pass full test data for the add function
      full_test_data: t,
    }));

    const { columnAccessor, direction } = sortStatus;
    data.sort((a, b) => {
      let valA = a[columnAccessor];
      let valB = b[columnAccessor];

      if (valA === undefined || valA === null) valA = -Infinity;
      if (valB === undefined || valB === null) valB = -Infinity;
      
      if (valA === Infinity) return direction === 'desc' ? -1 : 1;
      if (valB === Infinity) return direction === 'desc' ? 1 : -1;

      if (typeof valA === 'boolean' && typeof valB === 'boolean') {
        return direction === 'asc' ? (valA === valB ? 0 : valA ? 1 : -1) : (valA === valB ? 0 : valA ? -1 : 1);
      }

      if (typeof valA === 'string') {
        return direction === 'asc'
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);
      }

      if (valA > valB) return direction === 'asc' ? 1 : -1;
      if (valA < valB) return direction === 'asc' ? -1 : 1;
      return 0;
    });
    return data;
  }, [report.individual_tests, sortStatus]);
  
  const renderStatTile = (label, key, suffix = '', positiveColor = 'green', negativeColor = 'red') => {
    const value = stats?.[key];
    const color =
      value === undefined || value >= 0
        ? theme.colors[positiveColor][4]
        : theme.colors[negativeColor][4];
    return <StatTile label={label} value={value} color={color} suffix={suffix} />;
  };

  const gunbotWarning = report?.config?.gunbot_warning;
  
  return (
    <Stack gap="xl">
      {gunbotWarning && (
        <Alert icon={<IconInfoCircle size="1rem" />} title="Note on Exchange Mapping" color="yellow" variant="light">
            {gunbotWarning}
        </Alert>
      )}

      <Card withBorder radius="md" p="lg" bg="dark.6">
        <Group justify="space-between">
          <Title order={3}>{testName}</Title>
          {!isOverallView && (
            <Button
              size="xs"
              variant="light"
              onClick={() => setSelectedTestId(null)}
            >
              Back to Overview
            </Button>
          )}
        </Group>

        <Divider my="md" />

        <Grid gutter="xl">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <EquityChart data={activeData.equityCurve} theme={theme} />
          </Grid.Col>

          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Stack>
              <SimpleGrid cols={2} spacing="sm">
                {renderStatTile('Total Return', 'Total Return %', '%')}
                {renderStatTile('Buy & Hold', 'Buy & Hold %', '%', 'gray', 'gray')}
                {renderStatTile('Sharpe', 'Sharpe Ratio (ann.)')}
                {renderStatTile('Max DD', 'Max Drawdown %', '%', 'red', 'red')}
              </SimpleGrid>

              <UnstyledButton
                onClick={() => setAnalyticsExpanded((o) => !o)}
                mt="sm"
              >
                <Group justify="space-between">
                  <Text fw={500} size="sm">
                    Trade Analytics
                  </Text>
                  <IconChevronDown
                    size={16}
                    style={{
                      transform: `rotate(${analyticsExpanded ? 180 : 0}deg)`,
                      transition: 'transform 0.2s',
                    }}
                  />
                </Group>
              </UnstyledButton>

              <Collapse in={analyticsExpanded}>
                <SimpleGrid cols={2} spacing="sm">
                  <StatTile
                    label="Profit Factor"
                    value={stats['Profit Factor']}
                    color={theme.colors.blue[4]}
                    size="sm"
                  />
                  <StatTile
                    label="Win Rate"
                    value={stats['Win Rate %']}
                    color={theme.colors.blue[4]}
                    suffix="%"
                    size="sm"
                  />
                  <StatTile
                    label="Avg Win"
                    value={stats['Avg Win PnL %']}
                    color={theme.colors.teal[4]}
                    suffix="%"
                    size="sm"
                  />
                  <StatTile
                    label="Avg Loss"
                    value={stats['Avg Loss PnL %']}
                    color={theme.colors.red[4]}
                    suffix="%"
                    size="sm"
                  />
                </SimpleGrid>

                {hasParams && (
                  <Card
                    withBorder
                    radius="sm"
                    mt="md"
                    p="xs"
                    style={{ borderColor: '#3a3a3a' }}
                  >
                    <Text size="xs" fw={500} c="dimmed" mb={4}>
                      Parameters
                    </Text>
                    <SimpleGrid cols={2} spacing={4}>
                      {Object.entries(params).map(([key, value]) => (
                        <Group key={key} gap={4} justify="space-between">
                          <MantineTooltip
                            label={key.replace(/_/g, ' ')}
                            withinPortal
                          >
                            <Text
                              size="xs"
                              c="dimmed"
                              tt="capitalize"
                              truncate
                              maw={100}
                            >
                              {key.replace(/_/g, ' ')}
                            </Text>
                          </MantineTooltip>
                          <Text size="sm" fw={500}>
                            {String(value)}
                          </Text>
                        </Group>
                      ))}
                    </SimpleGrid>
                  </Card>
                )}
              </Collapse>
            </Stack>
          </Grid.Col>
        </Grid>

        {!isOverallView && hasExitData && (
          <>
            <Divider
              my="lg"
              labelPosition="center"
              label={
                <Group gap={4}>
                  <IconChartPie3 size={14} />
                  <Text size="xs">Exit Reason Distribution</Text>
                </Group>
              }
            />
            <Center>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={60}
                    label={false}
                  >
                    {pieData.map((entry) => (
                      <Cell
                        key={`cell-${entry.name}`}
                        fill={entry.fill}
                      />
                    ))}
                  </Pie>
                  <Legend />
                  <Tooltip formatter={(value, name) => [`${value} trades`, name]} />
                </PieChart>
              </ResponsiveContainer>
            </Center>
          </>
        )}
      </Card>

      {testsForTable.length > 0 && (
        <Card withBorder radius="md" p="lg" bg="dark.6">
          <Title order={4} mb="md">
            Individual Test Runs
          </Title>
          <DataTable
            height={380}
            minHeight={380}
            withTableBorder
            borderRadius="sm"
            striped
            highlightOnHover
            virtualized
            sortStatus={sortStatus}
            onSortStatusChange={setSortStatus}
            records={testsForTable}
            idAccessor="test_id"
            rowClassName={({ test_id }) =>
              test_id === selectedTestId
                ? 'mantine-datatable-row-highlight'
                : ''
            }
            onRowClick={({ record }) =>
              setSelectedTestId(
                record.test_id === selectedTestId ? null : record.test_id,
              )
            }
            expandedRecordIds={expandedRecordIds}
            onExpandedRecordIdsChange={setExpandedRecordIds}
            rowExpansion={{
              content: ({ record }) => {
                const { parameters } = record;
                const hasParams = parameters && Object.keys(parameters).length > 0;
                
                if (record.Strategy === 'ACTIVE PAIR') {
                  return (
                    <Paper bg="dark.5" p="md" m="md" withBorder radius="sm">
                      <Group gap="xs">
                        <IconBox size={18} />
                        <Text size="sm">Live Gunbot Strategy:</Text>
                        <Code>{parameters.strategy || 'N/A'}</Code>
                      </Group>
                    </Paper>
                  );
                }

                if (!hasParams) {
                  return (
                    <Paper bg="dark.5" p="md" m="md" withBorder radius="sm">
                       <Group gap="xs">
                        <IconBox size={18} />
                        <Text c="dimmed" size="sm">This strategy has no configurable parameters.</Text>
                      </Group>
                    </Paper>
                  );
                }

                return (
                  <Paper bg="dark.5" p="md" m="md" withBorder radius="sm">
                    <Title order={6} mb="sm">Strategy Parameters</Title>
                    <SimpleGrid cols={{ base: 2, sm: 3, md: 4}} spacing="xs" verticalSpacing="xs">
                      {Object.entries(parameters).map(([key, value]) => (
                        <div key={key}>
                          <Text size="xs" c="dimmed" tt="capitalize" truncate>{key.replace(/_/g, ' ')}</Text>
                          <Text size="sm" fw={500}>{String(value)}</Text>
                        </div>
                      ))}
                    </SimpleGrid>
                  </Paper>
                );
              },
            }}
            columns={[
              { accessor: 'Strategy', width: 220, sortable: true },
              { accessor: 'Symbol', width: 120, sortable: true },
              { accessor: 'Timeframe', width: 100, sortable: true },
              { accessor: 'Total Return %', title: 'Return %', sortable: true, textAlignment: 'right', render: ({ 'Total Return %': val }) => renderNumeric(val, 'teal', 'red', '%'), },
              { accessor: 'Profit Factor', title: 'P/F', sortable: true, textAlignment: 'right', render: ({ 'Profit Factor': val }) => renderNumeric(val), customCellAttributes: ({ 'Profit Factor': val }) => ({ title: val === Infinity ? '∞' : val?.toFixed(2) ?? 'N/A', }), },
              { accessor: 'Sharpe Ratio (ann.)', title: 'Sharpe', sortable: true, textAlignment: 'right', render: ({ 'Sharpe Ratio (ann.)': val }) => renderNumeric(val), },
              { accessor: 'Max Drawdown %', title: 'Max DD %', sortable: true, textAlignment: 'right', render: ({ 'Max Drawdown %': val }) => renderNumeric(val, 'red', 'red', '%'), },
              { accessor: 'Total Trades', title: 'Trades', sortable: true, textAlignment: 'right' },
              {
                accessor: 'actions', title: 'Actions', textAlignment: 'right', width: 100,
                render: (test) => {
                  const tooltipLabel = isGunbotConnected ? `Deploy ${test.Symbol} to Gunbot` : "Connect to Gunbot to add pairs";
                  const isAddable = !test.is_active_pair && test.Strategy !== "ACTIVE PAIR";
                  if (!isAddable) return null;
                  return (
                    <MantineTooltip label={tooltipLabel} withArrow>
                      <ActionIcon disabled={!isGunbotConnected} onClick={(e) => { e.stopPropagation(); if (onAddPair) onAddPair(test.full_test_data); }}>
                        <IconPlus size={16} />
                      </ActionIcon>
                    </MantineTooltip>
                  );
                },
              },
            ]}
          />
        </Card>
      )}
    </Stack>
  );
}

const renderNumeric = (
  value,
  colorPositive = 'teal',
  colorNegative = 'red',
  suffix = '',
) => {
  if (value === Infinity)
    return (
      <Text c="green" size="sm" ta="right">
        ∞
      </Text>
    );
  const num = value ?? 0;
  return (
    <Text
      c={num >= 0 ? colorPositive : colorNegative}
      size="sm"
      ta="right"
    >
      {num.toFixed(2)}
      {suffix}
    </Text>
  );
};
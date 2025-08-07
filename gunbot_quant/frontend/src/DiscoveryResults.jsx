/* eslint react/prop-types: 0 */
import { useState, useEffect, useMemo } from 'react';
import {
  Title, Paper, Alert, Center, Text, Grid, Stack, useMantineTheme, Group,
  Card, SimpleGrid, Code, Divider, Button, Select, ActionIcon, Tooltip as MantineTooltip,
  ThemeIcon,
} from '@mantine/core';
import { IconAlertTriangle, IconTrophy, IconInfoCircle, IconChartAreaLine, IconPlus } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from 'mantine-datatable';
import ResultsSkeleton from './ResultsSkeleton';
import dayjs from 'dayjs';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

// --- Re-usable components copied from ResultsDisplay for consistency ---
const StatTile = ({ label, value, color, suffix = '' }) => (
    <Paper withBorder p="xs" radius="md" style={{ background: 'transparent', borderColor: '#2a2a2a' }}>
        <Text size="xs" c="dimmed">{label}</Text>
        <Text size="lg" c={color} fw={600}>
            {typeof value === 'number' && !Number.isNaN(value) ? value.toFixed(2) : (value ?? '--')}
            {suffix}
        </Text>
    </Paper>
);

const CustomEquityTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    const strategyData = payload.find(p => p.dataKey === 'equity_strategy');
    const bhData = payload.find(p => p.dataKey === 'equity_buy_and_hold');
    return (
      <Paper withBorder shadow="md" radius="md" p="sm" style={{ backgroundColor: 'rgba(26, 27, 30, 0.85)' }}>
        <Text size="sm" mb={4}>{dayjs(label).format('MMM D, YYYY')}</Text>
        {bhData && <Text size="xs" c="white">{`Buy & Hold : $${(bhData.value).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</Text>}
        {strategyData && <Text size="xs" c="green">{`Strategy : $${(strategyData.value).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</Text>}
      </Paper>
    );
  }
  return null;
};

const EquityChart = ({ data, theme }) => {
  const { strategy, buy_and_hold } = data || {};
  if (!strategy || strategy.length < 2) {
    return <Center h={300}><Text c="dimmed">Not enough data to render chart.</Text></Center>;
  }

  const combinedData = useMemo(() => {
    const strategyMap = new Map(strategy.map(d => [d.date, d.value]));
    const bhMap = new Map((buy_and_hold || []).map(d => [d.date, d.value]));
    const allDates = [...new Set([...strategy.map(d => d.date), ...(buy_and_hold || []).map(d => d.date)])].sort();
    return allDates.map(date => ({
      date,
      equity_strategy: strategyMap.get(date),
      equity_buy_and_hold: bhMap.get(date),
    }));
  }, [strategy, buy_and_hold]);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={combinedData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <defs>
          <linearGradient id="colorStrategy" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={theme.colors.green[5]} stopOpacity={0.8} /><stop offset="95%" stopColor={theme.colors.green[5]} stopOpacity={0.1} /></linearGradient>
          <linearGradient id="colorBH" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={theme.colors.gray[6]} stopOpacity={0.4} /><stop offset="95%" stopColor={theme.colors.gray[6]} stopOpacity={0.05} /></linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.colors.dark[3]} />
        <XAxis dataKey="date" tickFormatter={(d) => dayjs(d).format('MMM D')} tick={{ fill: theme.colors.gray[5], fontSize: 12 }} stroke={theme.colors.dark[3]} />
        <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} domain={['dataMin', 'auto']} allowDataOverflow={false} tick={{ fill: theme.colors.gray[5], fontSize: 12 }} stroke={theme.colors.dark[3]} />
        <Tooltip content={<CustomEquityTooltip />} />
        <Area type="monotone" dataKey="equity_buy_and_hold" stroke={theme.colors.gray[5]} strokeWidth={1.5} fillOpacity={1} fill="url(#colorBH)" isAnimationActive={false} connectNulls />
        <Area type="monotone" dataKey="equity_strategy" stroke={theme.colors.green[4]} strokeWidth={2} fillOpacity={1} fill="url(#colorStrategy)" isAnimationActive={false} connectNulls />
      </AreaChart>
    </ResponsiveContainer>
  );
};

const renderNumeric = (value, colorPositive = 'teal', colorNegative = 'red', suffix = '') => {
  if (value === Infinity) return <Text c="green" size="sm" ta="right">∞</Text>;
  const num = value ?? 0;
  return <Text c={num >= 0 ? colorPositive : colorNegative} size="sm" ta="right" fw={500}>{num.toFixed(2)}{suffix}</Text>;
};

const fetchGunbotStatus = async () => {
    const res = await fetch('/api/v1/gunbot/status');
    if (!res.ok) throw new Error('Network response was not ok');
    return res.json();
};

export default function DiscoveryResults({ initialJobId, navigateToGunbotConnect, onAddPair }) {
    const theme = useMantineTheme();
    const [jobList, setJobList] = useState([]);
    const [selectedJobId, setSelectedJobId] = useState(initialJobId || null);
    const [loadingList, setLoadingList] = useState(true);
    const [loadingReport, setLoadingReport] = useState(false);
    const [report, setReport] = useState(null);
    const [error, setError] = useState(null);
    const [selectedTestId, setSelectedTestId] = useState(null);
    const [sortStatus, setSortStatus] = useState({ columnAccessor: 'rank', direction: 'asc' });
    
    const { data: gunbotStatus } = useQuery({ queryKey: ['gunbotStatus'], queryFn: fetchGunbotStatus });
    const isGunbotConnected = gunbotStatus?.connected === true;

    useEffect(() => {
        const fetchJobList = async () => {
          setLoadingList(true);
          try {
            const response = await fetch('/api/v1/gunbot/discovery/results');
            if (!response.ok) throw new Error('Failed to fetch discovery result list');
            setJobList(await response.json());
          } catch (err) {
            setError(err.message);
          } finally {
            setLoadingList(false);
          }
        };
        fetchJobList();
      }, []);

    useEffect(() => {
        if (initialJobId) {
            setSelectedJobId(initialJobId);
        }
    }, [initialJobId]);


    useEffect(() => {
        if (selectedJobId) {
            const fetchReport = async () => {
                setLoadingReport(true); 
                setReport(null); 
                setError(null);
                try {
                    const response = await fetch(`/api/v1/backtest/results/${selectedJobId}`);
                    if (!response.ok) throw new Error(`Failed to fetch report for ${selectedJobId}`);
                    setReport(await response.json());
                } catch (err) { setError(err.message); } finally { setLoadingReport(false); }
            };
            fetchReport();
        }
    }, [selectedJobId]);

    const { activePairTest, sortedCandidates } = useMemo(() => {
        if (!report?.individual_tests) return { activePairTest: null, sortedCandidates: [] };

        const activePairTest = report.individual_tests.find(t => t.is_active_pair);
        
        // --- THIS IS THE FIX ---
        // The candidate list IS the list of full test data objects. No more mapping/flattening.
        const candidates = report.individual_tests.filter(t => !t.is_active_pair);

        // First sort by Sharpe to assign rank
        const ranked = [...candidates].sort((a, b) => (b.stats['Sharpe Ratio (ann.)'] ?? -Infinity) - (a.stats['Sharpe Ratio (ann.)'] ?? -Infinity))
            .map((c, i) => ({ ...c, rank: i + 1 }));

        // Then apply the user's interactive sorting
        const { columnAccessor, direction } = sortStatus;
        ranked.sort((a, b) => {
            let valA, valB;
            // Check if sorting by a top-level property or a nested stat
            if (['symbol', 'strategy_name', 'rank'].includes(columnAccessor)) {
                valA = a[columnAccessor];
                valB = b[columnAccessor];
            } else {
                valA = a.stats[columnAccessor];
                valB = b.stats[columnAccessor];
            }
            valA = valA ?? -Infinity;
            valB = valB ?? -Infinity;

            if (typeof valA === 'string') return direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            return direction === 'asc' ? valA - valB : valB - valA;
        });

        return { activePairTest, sortedCandidates: ranked };
    }, [report, sortStatus]);
    
    const selectedCandidate = useMemo(() => {
        return sortedCandidates.find(c => c.test_id === selectedTestId);
    }, [sortedCandidates, selectedTestId]);

    if (loadingReport) return <ResultsSkeleton />;
    if (error) return <Alert title="Error" color="red" icon={<IconAlertTriangle />}>{error}</Alert>;
    
    const analysisPeriod = report ? `from ${report.config.BACKTEST_START_DATE} to ${report.config.BACKTEST_END_DATE}` : '';
    const gunbotWarning = report?.config?.gunbot_warning;

    return (
        <Stack gap="xl">
            <Title order={2}>Discovery Results</Title>
            
            <Paper withBorder p="md" radius="md">
                <Select
                    label="Select a Saved Discovery or Benchmark Report"
                    placeholder={loadingList ? "Loading reports..." : "Choose a run"}
                    data={jobList}
                    value={selectedJobId}
                    onChange={(val) => {
                        setSelectedJobId(val);
                        setSelectedTestId(null); // Reset detail view when changing report
                    }}
                    disabled={loadingList}
                    searchable
                />
            </Paper>

            {!selectedJobId && (
                 <Center h={400}>
                    <Stack align="center" spacing="md">
                        <IconTrophy size={60} stroke={1.5} color={theme.colors.gray[6]} />
                        <Title order={3} ta="center">Select a Report</Title>
                        <Text c="dimmed" ta="center">
                            Choose a previous "Find Better Pair" or "Benchmark" run from the dropdown.
                            <br />
                            If the list is empty, you can start a new run from the Gunbot Tools page.
                        </Text>
                        {jobList.length === 0 && !loadingList && (
                             <Button mt="md" onClick={navigateToGunbotConnect} variant="light">Go to Gunbot Tools</Button>
                        )}
                    </Stack>
                </Center>
            )}

            {report && activePairTest && (
                <>
                {gunbotWarning && (
                    <Alert icon={<IconInfoCircle size="1rem" />} title="Note on Exchange Mapping" color="yellow" variant="light" radius="md">
                        {gunbotWarning}
                    </Alert>
                )}
                
                <Paper withBorder p="md" radius="md" bg="dark.7">
                    <Group>
                        <ThemeIcon variant="light" color="blue" size={36} radius="md">
                            <IconInfoCircle size={20} />
                        </ThemeIcon>
                        <div>
                            <Text fw={500}>Historical Analysis for {activePairTest?.symbol}</Text>
                            <Text size="sm" c="dimmed">
                                This report benchmarks your active pair against alternatives from {analysisPeriod}, using a collection of trading strategies.
                            </Text>
                        </div>
                    </Group>
                </Paper>
                
                <Grid gutter="xl">
                    <Grid.Col span={{ base: 12, lg: 5 }}>
                        <Card withBorder p="lg" radius="md" h="100%">
                            <Title order={4} mb="md">Baseline: Active Pair (Live Performance)</Title>
                            <SimpleGrid cols={2}>
                                <StatTile label="Total Return" value={activePairTest.stats['Total Return %']} suffix="%" color={activePairTest.stats['Total Return %'] > 0 ? 'green' : 'red'} />
                                <StatTile label="Sharpe Ratio" value={activePairTest.stats['Sharpe Ratio (ann.)']} color="cyan" />
                                <StatTile label="Max Drawdown" value={activePairTest.stats['Max Drawdown %']} suffix="%" color="orange" />
                                <StatTile label="Profit Factor" value={activePairTest.stats['Profit Factor']} color="grape" />
                            </SimpleGrid>
                            <Divider my="md" label="Strategy & Duration" labelPosition="center" />
                            <Group justify="space-between">
                                <Text size="sm" c="dimmed">Name</Text><Code>{activePairTest.parameters.strategy}</Code>
                            </Group>
                            <Group justify="space-between" mt="xs">
                                <Text size="sm" c="dimmed">Live Duration</Text><Text fw={500}>{activePairTest.stats['Duration (days)']} days</Text>
                            </Group>
                            <Group justify="space-between" mt="xs">
                                <Text size="sm" c="dimmed">Total Trades</Text><Text fw={500}>{activePairTest.stats['Total Trades']}</Text>
                            </Group>
                        </Card>
                    </Grid.Col>
                    <Grid.Col span={{ base: 12, lg: 7 }}>
                        {selectedCandidate ? (
                            <Card withBorder p="lg" radius="md" h="100%">
                                <Title order={4} mb="md">Potential Performance: {selectedCandidate.symbol} with {selectedCandidate.strategy_name}</Title>
                                <EquityChart data={selectedCandidate.equity_curve} theme={theme} />
                            </Card>
                        ) : (
                            <Card withBorder p="lg" radius="md" h="100%">
                            <Center h="100%">
                                    <Stack align="center">
                                        <IconChartAreaLine size={48} stroke={1.5} color={theme.colors.gray[6]} />
                                        <Title order={4} c="dimmed">Select a Pair</Title>
                                        <Text c="dimmed">Click a row in the table below to see its performance chart.</Text>
                                    </Stack>
                                </Center>
                            </Card>
                        )}
                    </Grid.Col>
                </Grid>

                <Paper withBorder p="lg" radius="md">
                    <Group mb="md">
                        <IconTrophy size={24} color={theme.colors.yellow[6]} />
                        <Title order={4}>Top Discovered Alternatives</Title>
                    </Group>
                    <DataTable
                        minHeight={400}
                        withTableBorder borderRadius="sm" striped highlightOnHover
                        records={sortedCandidates} idAccessor="test_id"
                        rowClassName={({ test_id }) => test_id === selectedTestId ? 'mantine-datatable-row-highlight' : ''}
                        onRowClick={({ record }) => setSelectedTestId(record.test_id === selectedTestId ? null : record.test_id)}
                        sortStatus={sortStatus} onSortStatusChange={setSortStatus}
                        columns={[
                            { accessor: 'rank', title: 'Rank', textAlignment: 'center', width: 70, sortable: true },
                            { accessor: 'symbol', title: 'Symbol', width: 120, sortable: true },
                            { accessor: 'strategy_name', title: 'Best Strategy Found', render: ({ strategy_name }) => <Code>{strategy_name}</Code>, sortable: true },
                            { accessor: 'stats.Sharpe Ratio (ann.)', title: 'Sharpe', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.stats['Sharpe Ratio (ann.)'], 'cyan') },
                            { accessor: 'stats.Total Return %', title: 'Return %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.stats['Total Return %'], 'teal', 'red', '%') },
                            { accessor: 'stats.Max Drawdown %', title: 'Max DD %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.stats['Max Drawdown %'], 'orange', 'orange', '%') },
                            { accessor: 'stats.Win Rate %', title: 'Win Rate %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.stats['Win Rate %'], 'blue', 'red', '%') },
                            { accessor: 'stats.Total Trades', title: 'Trades', textAlignment: 'right', sortable: true, render: (r) => r.stats['Total Trades']},
                            {
                                accessor: 'actions', title: 'Actions', textAlignment: 'right', width: 100,
                                render: (candidate) => {
                                    const tooltipLabel = isGunbotConnected ? `Deploy ${candidate.symbol} to Gunbot` : "Connect to Gunbot to add pairs";
                                    return (
                                        <MantineTooltip label={tooltipLabel} withArrow>
                                            <ActionIcon disabled={!isGunbotConnected} onClick={(e) => { e.stopPropagation(); if (onAddPair) onAddPair(candidate); }}>
                                                <IconPlus size={16} />
                                            </ActionIcon>
                                        </MantineTooltip>
                                    );
                                },
                            },
                        ]}
                        noRecordsText="No alternative pairs could be benchmarked."
                    />
                </Paper>
                </>
            )}
        </Stack>
    );
}
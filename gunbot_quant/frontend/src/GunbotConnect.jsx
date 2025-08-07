import { useState, useEffect, useMemo, memo, forwardRef, useRef } from 'react';
import {
  Alert, Button, Card, Center, Code, Collapse, Group, Loader, Paper, PasswordInput,
  Stack, Text, Title, useMantineTheme, ActionIcon, Grid, NumberInput, Select, TextInput, ScrollArea,
  SimpleGrid, UnstyledButton, Tooltip as MantineTooltip, ThemeIcon, Box, List, Badge, Table,
  Breadcrumbs, Anchor, MultiSelect, SegmentedControl, Portal, Overlay
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { DatePickerInput } from '@mantine/dates';
import {
  IconCheck, IconCircleX, IconInfoCircle, IconPlugConnected, IconPlugConnectedX,
  IconKey, IconServer, IconChevronDown, IconAlertTriangle, IconGraph, IconX,
  IconRefresh, IconTestPipe, IconZoomCode, IconHistory, IconRobot, IconChartAreaLine,
  IconTrash, IconActivity, IconPlayerPlay, IconPlayerPause, IconClockHour4, IconWallet
} from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { DataTable } from 'mantine-datatable';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import dayjs from 'dayjs';

// --- Re-usable constants ---
const AVAILABLE_TIMEFRAMES_FOR_ANALYSIS = [
    { value: '5m', label: '5 Minutes' },
    { value: '15m', label: '15 Minutes' },
    { value: '30m', label: '30 Minutes' },
    { value: '1h', label: '1 Hour' },
    { value: '2h', label: '2 Hours' },
    { value: '4h', label: '4 Hours' },
    { value: '6h', label: '6 Hours' },
    { value: '12h', label: '12 Hours' },
    { value: '1d', label: '1 Day' },
];

// --- Re-usable Helpers ---
const formatCurrency = (val, precision = 2) => (typeof val === 'number' ? val.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision }) : 'N/A');
const formatCoin = (val) => (typeof val === 'number' ? val.toFixed(6) : 'N/A');
const formatTimeframe = (min) => { const minutes = parseInt(min, 10); if (isNaN(minutes) || minutes <= 0) return '—'; if (minutes < 60) return `${minutes}m`; if (minutes < 1440) return `${(minutes / 60).toFixed(0)}h`; return `${(minutes / 1440).toFixed(0)}d`; };
const downsample = (data, maxPoints = 500) => { if (!Array.isArray(data) || data.length <= maxPoints) return data; const step = Math.ceil(data.length / maxPoints); const result = []; for (let i = 0; i < data.length; i += step) { result.push(data[i]); } return result; };

// --- API Fetchers & Mutations ---
const fetchGunbotStatus = async () => { const res = await fetch('/api/v1/gunbot/status'); if (!res.ok) throw new Error('Network response was not ok'); return res.json(); };
const fetchTradingPairs = async () => { const res = await fetch('/api/v1/gunbot/trading-pairs'); if (!res.ok) { const err = await res.json(); throw new Error(err.detail || 'Could not fetch trading pair data'); } return res.json(); };
const connectToGunbot = async ({ password, gunthy_wallet, protocol, host, port }) => { const res = await fetch('/api/v1/gunbot/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, gunthy_wallet, protocol, host, port }), }); const data = await res.json(); if (!res.ok) throw new Error(data.detail || 'Failed to connect'); return data; };
const disconnectFromGunbot = async () => { const res = await fetch('/api/v1/gunbot/disconnect', { method: 'POST' }); const data = await res.json(); if (!res.ok) throw new Error(data.detail || 'Failed to disconnect'); return data; };
const removePairFromGunbot = async ({ exchange, gunbot_pair }) => { const res = await fetch('/api/v1/gunbot/pairs/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exchange, gunbot_pair }), }); const data = await res.json(); if (!res.ok) throw new Error(data.detail || 'Failed to remove pair'); return data; };

// --- Small UI Components ---
const StatTile = memo(({ label, value, color, suffix = '', size = 'md', tooltip }) => { const content = ( <Paper withBorder p="xs" radius="md" style={{ background: 'transparent' }}> <Text size="xs" c="dimmed" truncate>{label}</Text> <Text size={size} c={color} fw={600}>{value}{suffix}</Text> </Paper> ); if (tooltip) return <MantineTooltip label={tooltip} withArrow withinPortal multiline w={240}>{content}</MantineTooltip>; return content; });
StatTile.displayName = 'StatTile';
const SparklineBase = ({ data, color, height = 20 }, ref) => { if (!data || data.length < 2) return <Box h={height} ref={ref} />; return ( <Box w={100} h={height} ref={ref}><ResponsiveContainer><LineChart data={data}><Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></Box> ); };
const Sparkline = memo(forwardRef(SparklineBase));
function FeatureCard({ icon: Icon, title, description, color='blue' }) {
    return (
        <Paper withBorder p="sm" radius="md" bg="dark.7">
            <Group>
                <ThemeIcon variant="light" color={color} size={36} radius="md">
                    <Icon size={20} />
                </ThemeIcon>
                <div>
                    <Text fw={500}>{title}</Text>
                    <Text size="sm" c="dimmed">{description}</Text>
                </div>
            </Group>
        </Paper>
    );
}

// --- Chart Helpers ---
const createEquityChartData = (pairData, initialCapital) => { if (!pairData?.orders?.length) return []; const history = [...pairData.orders].reverse(); const firstTrade = history.find(t => t.rate > 0); if (!firstTrade) return []; const firstTradePrice = firstTrade.rate; const bhCoins = initialCapital / firstTradePrice; let cash = initialCapital; let baseQty = 0; const chartData = [{ time: firstTrade.time - 3600000, strategy: initialCapital, buyAndHold: initialCapital }]; for (const trade of history) { if (trade.type === 'buy') { cash -= trade.cost; baseQty += trade.amount; } else if (trade.type === 'sell') { cash += trade.cost; baseQty -= trade.amount; } const currentStrategyEquity = cash + (baseQty * trade.rate); const bhEquity = bhCoins * trade.rate; chartData.push({ time: trade.time, strategy: currentStrategyEquity, buyAndHold: bhEquity }); } if (chartData.length > 1) { const lastStateEquity = cash + (baseQty * pairData.bid); chartData.push({ time: Date.now(), strategy: lastStateEquity, buyAndHold: bhCoins * pairData.bid }); } return downsample(chartData, 500); };
const CustomEquityTooltip = ({ active, payload, label }) => { if (active && payload && payload.length) { const strategyData = payload.find(p => p.dataKey === 'strategy'); const bhData = payload.find(p => p.dataKey === 'buyAndHold'); return ( <Paper withBorder shadow="md" radius="md" p="sm" style={{ backgroundColor: 'rgba(26, 27, 30, 0.85)' }}><Text size="sm" mb={4}>{dayjs(label).format('MMM D, YYYY')}</Text>{bhData && <Text size="xs" c="white">{`Buy & Hold : $${formatCurrency(bhData.value)}`}</Text>}{strategyData && <Text size="xs" c="green">{`Strategy : $${formatCurrency(strategyData.value)}`}</Text>}</Paper> ); } return null; };
const EquityChart = memo(({ data, theme }) => { if (!data || data.length < 2) { return ( <Center h={250}><Stack align="center" gap="xs"><IconAlertTriangle size={32} color={theme.colors.gray[6]} /><Text c="dimmed" size="sm">Not enough trade history to render chart.</Text></Stack></Center> ); } return ( <> <ResponsiveContainer width="100%" height={250}><AreaChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}><CartesianGrid strokeDasharray="3 3" stroke={theme.colors.dark[4]} /><XAxis dataKey="time" tickFormatter={(d) => dayjs(d).format('MMM DD')} tick={{ fill: theme.colors.gray[5], fontSize: 11 }} stroke={theme.colors.dark[4]} /><YAxis yAxisId="0" tickFormatter={(v) => `$${formatCurrency(v, 0)}`} domain={['dataMin', 'auto']} tick={{ fill: theme.colors.gray[3], fontSize: 11 }} stroke={theme.colors.dark[4]} allowDataOverflow={false} /><Tooltip content={<CustomEquityTooltip />} /><Area yAxisId="0" type="monotone" dataKey="buyAndHold" name="Buy & Hold" stroke={theme.colors.gray[5]} fill={theme.colors.gray[8]} fillOpacity={0.3} strokeWidth={1.5} isAnimationActive={false} connectNulls /><Area yAxisId="0" type="monotone" dataKey="strategy" name="Strategy" stroke={theme.colors.green[4]} fill={theme.colors.green[8]} fillOpacity={0.3} strokeWidth={2} isAnimationActive={false} connectNulls /></AreaChart></ResponsiveContainer><Group justify="center" gap="xl" mt="xs"><Group gap="xs" align="center"><Box w={12} h={2} bg={theme.colors.gray[5]} /><Text size="xs" c="dimmed">Buy & Hold</Text></Group><Group gap="xs" align="center"><Box w={12} h={2} bg={theme.colors.green[4]} /><Text size="xs" c="dimmed">Strategy</Text></Group></Group> </> ); });
EquityChart.displayName = 'EquityChart';

// --- Portal Modal Component ---
const MODAL_Z = 10000;
const PANEL_Z = MODAL_Z + 1;

function SafeModal({ opened, onClose, size = 'md', children }) {
  if (!opened) return null;
  const width =
    size === 'lg' ? 600 : size === 'md' ? 400 : size === 'sm' ? 320 : size;

  return (
    <Portal>
      <Overlay
        opacity={0.55}
        blur={2}
        fixed
        onClick={onClose}
        zIndex={MODAL_Z}
      />
      <Paper
        withBorder
        shadow="lg"
        radius="md"
        p="lg"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width,
          maxHeight: '80vh',
          overflowY: 'auto',
          overflowX: 'visible',
          zIndex: PANEL_Z,
          background: 'var(--mantine-color-body, #1A1B1E)',
        }}
      >
        {children}
      </Paper>
    </Portal>
  );
}


export default function GunbotConnect({ navigateToResult, navigateToDiscoveryResult }) {
  const theme = useMantineTheme();
  const queryClient = useQueryClient();

  const [password, setPassword] = useState('');
  const [gunthyWallet, setGunthyWallet] = useState('');
  const [protocol, setProtocol] = useState('http');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState(3000);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [selectedPairKey, setSelectedPairKey] = useState(null);
  const [assumedCapital, setAssumedCapital] = useState(1000);
  const [job, setJob] = useState({ id: null, type: null, status: 'idle' });
  const pollingRef = useRef(null);
  const prevIsConnectedRef = useRef();
  const [confirmation, setConfirmation] = useState(null);
  const [timeframesToTest, setTimeframesToTest] = useState(['1h', '4h']);
  
  const [discoveryCandidateCount, setDiscoveryCandidateCount] = useState(200);
  const [discoveryMinDailyVolume, setDiscoveryMinDailyVolume] = useState(1_000_000);
  const [discoveryDateType, setDiscoveryDateType] = useState('active_pair_time');
  const [discoveryDateRange, setDiscoveryDateRange] = useState([dayjs().subtract(30, 'days').toDate(), new Date()]);
  const [discoveryTimeframe, setDiscoveryTimeframe] = useState('1h');

  const [benchmarkDateType, setBenchmarkDateType] = useState('active_pair_time');
  const [benchmarkDateRange, setBenchmarkDateRange] = useState([dayjs().subtract(30, 'days').toDate(), new Date()]);
  const [normalizationCache, setNormalizationCache] = useState({});
  const [isNormalizing, setIsNormalizing] = useState(false);

  const [pairToRemove, setPairToRemove] = useState(null);
  const [removeModalOpened, { open: openRemoveModal, close: closeRemoveModal }] = useDisclosure(false);

  const { data: statusData, isLoading: isStatusLoading, isError: isStatusError } = useQuery({ queryKey: ['gunbotStatus'], queryFn: fetchGunbotStatus, refetchInterval: 30000 });
  const isConnected = statusData?.connected === true;

  const { data: tradingPairs, isLoading: isDataLoading, error: dataError, isRefetching } = useQuery({
    queryKey: ['gunbotTradingPairs'],
    queryFn: fetchTradingPairs,
    enabled: isConnected,
    refetchInterval: 60000,
  });
  
  const removePairMutation = useMutation({
    mutationFn: removePairFromGunbot,
    onSuccess: (data, variables) => {
      notifications.show({ title: 'Success', message: data.message, color: 'green', icon: <IconCheck /> });
      queryClient.invalidateQueries({ queryKey: ['gunbotTradingPairs'] });
      closeRemoveModal();
      setPairToRemove(null);
      if (selectedPairKey === variables.gunbot_pair.split('-').reverse().join('')) {
          setSelectedPairKey(null);
      }
    },
    onError: (error) => {
      notifications.show({ title: 'Error Removing Pair', message: error.message, color: 'red' });
    },
  });

  const selectedPairData = useMemo(() => (
    tradingPairs && selectedPairKey ? tradingPairs[selectedPairKey] : null
  ), [tradingPairs, selectedPairKey]);
  
  useEffect(() => {
    if (!tradingPairs || Object.keys(tradingPairs).length === 0) {
      setNormalizationCache({});
      return;
    };

    const normalizeAllPairs = async () => {
      setIsNormalizing(true);
      const newCache = { ...normalizationCache }; // Keep old results in case of partial failure
      const pairsToNormalize = Object.values(tradingPairs).filter(p => !newCache[p.standard_pair_format]);

      if (pairsToNormalize.length === 0) {
        setIsNormalizing(false);
        return;
      }

      await Promise.all(pairsToNormalize.map(async (pair) => {
        try {
          const res = await fetch('/api/v1/gunbot/normalize-pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pair_data: pair }),
          });
          if (res.ok) {
            const data = await res.json();
            newCache[pair.standard_pair_format] = data;
          } else {
            newCache[pair.standard_pair_format] = { gq_exchange: 'Error', warning: 'Normalization failed' };
          }
        } catch (e) {
          console.error(`Failed to normalize ${pair.standard_pair_format}`, e);
          newCache[pair.standard_pair_format] = { gq_exchange: 'Error', warning: 'Network error during normalization' };
        }
      }));

      setNormalizationCache(newCache);
      setIsNormalizing(false);
    };

    normalizeAllPairs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradingPairs]);

  useEffect(() => {
    if (statusData?.config) {
      setProtocol(statusData.config.protocol || 'http');
      setHost(statusData.config.host || 'localhost');
      setPort(statusData.config.port || 3000);
    }
    const shouldShowSettings = !statusData?.connected;
    setShowConnectionSettings(shouldShowSettings);
  }, [statusData]);

  // --- NEW EFFECT TO HANDLE RECONNECTION ---
  useEffect(() => {
    const wasConnected = prevIsConnectedRef.current;
    if (wasConnected === false && isConnected === true) {
      notifications.show({
        title: 'Gunbot Reconnected',
        message: 'Connection restored. Data will be refreshed automatically.',
        color: 'green',
        icon: <IconCheck />,
      });
      queryClient.invalidateQueries({ queryKey: ['gunbotConfig'] });
    }
    prevIsConnectedRef.current = isConnected;
  }, [isConnected, queryClient]);

  useEffect(() => {
    if (selectedPairKey) {
      const savedCapital = localStorage.getItem(`gbq_initial_capital_${selectedPairKey}`);
      setAssumedCapital(savedCapital ? parseFloat(savedCapital) : 1000);
      try {
        const pairTf = tradingPairs[selectedPairKey]?.candleTimeFrame;
        const pairTfString = formatTimeframe(pairTf);
        const isValidTf = AVAILABLE_TIMEFRAMES_FOR_ANALYSIS.some(tf => tf.value === pairTfString);
        setDiscoveryTimeframe(isValidTf ? pairTfString : '1h');
      } catch (e) {
        setDiscoveryTimeframe('1h');
      }
    } else {
        setJob({ id: null, type: null, status: 'idle' });
        setConfirmation(null);
        stopPolling();
    }
  }, [selectedPairKey, tradingPairs]);

  const handleCapitalChange = (value) => {
    const numericValue = Number(value) || 1;
    setAssumedCapital(numericValue);
    if (selectedPairKey) {
      localStorage.setItem(`gbq_initial_capital_${selectedPairKey}`, numericValue);
    }
  };

  const stopPolling = () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  useEffect(() => () => stopPolling(), []);

  const checkJobStatus = async (currentJobId) => { try { const resp = await fetch(`/api/v1/backtest/status/${currentJobId}`); const data = await resp.json(); if (!resp.ok) throw new Error(data.detail || 'Failed to fetch job status'); if (data.status === 'completed') { setJob(prev => ({...prev, status: 'completed' })); notifications.show({ title: 'Job Completed', message: `Report for ${currentJobId} is ready.`, color: 'green', icon: <IconCheck />, autoClose: 10000, }); stopPolling(); } else if (data.status === 'failed') { setJob(prev => ({...prev, status: 'failed' })); notifications.show({ title: 'Job Failed', message: data.report?.error || 'An unexpected error occurred.', color: 'red', }); stopPolling(); } } catch (err) { setJob(prev => ({...prev, status: 'failed' })); notifications.show({ title: 'Polling Error', message: err.message, color: 'red' }); stopPolling(); } };
  
  const startJob = (endpoint, payload, title, type) => {
    setJob({ id: null, type, status: 'running' });
    setConfirmation(null);
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Failed to start ${title}`);
      return data;
    }).then(data => {
      notifications.show({ title: `${title} Started`, message: `Job '${data.job_id}' is running.`, color: 'blue' });
      setJob({ id: data.job_id, type, status: 'running' });
      const checker = () => checkJobStatus(data.job_id);
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(checker, 5000);
      setTimeout(checker, 1000);
    }).catch(error => {
      notifications.show({ title: `${title} Failed to Start`, message: error.message, color: 'red' });
      setJob({ id: null, type, status: 'failed' });
    });
  };

  const connectMutation = useMutation({
    mutationFn: connectToGunbot,
    onSuccess: (data) => {
      notifications.show({ title: 'Success', message: data.message, color: 'green', icon: <IconCheck /> });
      queryClient.invalidateQueries({ queryKey: ['gunbotStatus'] });
      queryClient.invalidateQueries({ queryKey: ['gunbotConfig'] });
      setPassword('');
      setGunthyWallet('');
    },
    onError: (error) => {
      notifications.show({ title: 'Connection Failed', message: error.message, color: 'red' });
    },
  });
  const disconnectMutation = useMutation({ mutationFn: disconnectFromGunbot, onSuccess: (data) => { notifications.show({ title: 'Success', message: data.message, color: 'blue' }); queryClient.invalidateQueries({ queryKey: ['gunbotStatus'] }); queryClient.removeQueries({ queryKey: ['gunbotTradingPairs'] }); setSelectedPairKey(null); }, onError: (error) => { notifications.show({ title: 'Disconnection Failed', message: error.message, color: 'red' }); }, });
  
  const handleConnect = () => { if (password.trim() && gunthyWallet.trim() && host.trim() && port > 0) connectMutation.mutate({ password, gunthy_wallet: gunthyWallet, protocol, host, port }); };
  const handleRefresh = () => { queryClient.invalidateQueries({ queryKey: ['gunbotTradingPairs'] }); };
  const handleRemoveClick = (pair) => { setPairToRemove(pair); openRemoveModal(); };
  const handleConfirmRemove = () => { if (pairToRemove) { removePairMutation.mutate({ exchange: pairToRemove.exchange, gunbot_pair: pairToRemove.gunbot_pair_format }); } };


  const handleRunBenchmarkConfirm = () => {
    if (!selectedPairData) return;
    const jobName = `Benchmark-${selectedPairData.standard_pair_format}-${dayjs().format('YYYY-MM-DD_HH-mm')}`;
    const payload = {
      job_name: jobName,
      pair_data: selectedPairData,
      initial_capital: assumedCapital,
      timeframes_to_test: timeframesToTest,
      start_date: null,
      end_date: null,
    };
    if (benchmarkDateType === 'custom_range' && benchmarkDateRange[0] && benchmarkDateRange[1]) {
        payload.start_date = dayjs(benchmarkDateRange[0]).format('YYYY-MM-DD');
        payload.end_date = dayjs(benchmarkDateRange[1]).format('YYYY-MM-DD');
    }
    startJob('/api/v1/gunbot/benchmark', payload, 'Benchmark', 'benchmark');
  };

  const setDiscoveryDatePreset = (days) => {
    setDiscoveryDateType('custom_range');
    setDiscoveryDateRange([dayjs().subtract(days, 'days').toDate(), new Date()]);
  };
   const setBenchmarkDatePreset = (days) => {
    setBenchmarkDateType('custom_range');
    setBenchmarkDateRange([dayjs().subtract(days, 'days').toDate(), new Date()]);
  };


  const handleFindBetterPairConfirm = () => {
    if (!selectedPairData) return;
    const jobName = `Discovery-${selectedPairData.standard_pair_format}-${dayjs().format('YYYY-MM-DD_HH-mm')}`;
    
    const payload = {
      job_name: jobName,
      pair_data: selectedPairData,
      initial_capital: assumedCapital,
      candidate_count: discoveryCandidateCount,
      min_daily_volume: discoveryMinDailyVolume,
      timeframe: discoveryTimeframe,
      start_date: null,
      end_date: null,
    };

    if (discoveryDateType === 'custom_range' && discoveryDateRange[0] && discoveryDateRange[1]) {
        payload.start_date = dayjs(discoveryDateRange[0]).format('YYYY-MM-DD');
        payload.end_date = dayjs(discoveryDateRange[1]).format('YYYY-MM-DD');
    }

    startJob('/api/v1/gunbot/find-better-pair', payload, 'Pair Discovery', 'discovery');
  };

  const handleViewReport = () => {
      if (job.type === 'discovery') {
          navigateToDiscoveryResult(job.id);
      } else {
          navigateToResult(job.id);
      }
  };

  const tableRecords = useMemo(() => { if (!tradingPairs) return []; const totalAbsPnl = Object.values(tradingPairs).reduce((total, d) => total + Math.abs(d.orders.reduce((sum, o) => sum + (o.pnl || 0), 0)), 0); return Object.values(tradingPairs).map(d => { const onSellOrdersValue = d.openOrders.filter(o => o.type === 'sell').reduce((s, o) => s + (o.amount * o.rate), 0); const avgCostCoinValue = d.quoteBalance * d.unitCost; const currentTotalValue = (d.quoteBalance * d.bid) + onSellOrdersValue; const avgCostTotalValue = avgCostCoinValue + onSellOrdersValue; const dd = avgCostTotalValue > 0 ? ((currentTotalValue - avgCostTotalValue) / avgCostTotalValue) * 100 : 0; const realizedPnl = d.orders.reduce((sum, o) => sum + (o.pnl || 0), 0); const pnlHistory = []; let cumulativePnl = 0; const ddHistory = []; const reversedOrders = [...d.orders].reverse(); if (reversedOrders.length > 0) { pnlHistory.push({ value: 0 }); ddHistory.push({ value: 0 }); } for (const trade of reversedOrders) { if (trade.type === 'sell' && typeof trade.pnl === 'number') pnlHistory.push({ value: cumulativePnl += trade.pnl }); if (trade.abp > 0) ddHistory.push({ value: ((trade.rate - trade.abp) / trade.abp) * 100 }); } const pairVolume24h = d.orders.filter(o => o.time >= Date.now() - 86400000).reduce((s, o) => s + o.cost, 0); const pnlShare = totalAbsPnl > 0 ? (Math.abs(realizedPnl) / totalAbsPnl) * 100 : 0; return { ...d, id: d.standard_pair_format, bagSize: avgCostCoinValue, realizedPnl, drawdown: dd, pnlHistory: downsample(pnlHistory, 50), ddHistory: downsample(ddHistory, 50), tradedVolume24h: pairVolume24h, pnlShare, candleTimeFrame: d.candleTimeFrame, }; }); }, [tradingPairs]);
  const equityChartData = useMemo(() => { return selectedPairData ? createEquityChartData(selectedPairData, assumedCapital) : []; }, [selectedPairData, assumedCapital]);
  const detailData = useMemo(() => { if (!selectedPairData) return { balances: {}, totalReturn: 0 }; const { quoteBalance, baseBalance, openOrders, gunbot_pair_format } = selectedPairData; const onBuyOrdersValue = openOrders.filter(o => o.type === 'buy').reduce((s, o) => s + o.cost, 0); const onSellOrdersValue = openOrders.filter(o => o.type === 'sell').reduce((s, o) => s + (o.amount * o.rate), 0); const pairRecord = tableRecords.find(r => r.id === selectedPairKey); const finalEquity = equityChartData.length > 0 ? equityChartData[equityChartData.length - 1].strategy : assumedCapital; const totalReturn = assumedCapital > 0 ? ((finalEquity / assumedCapital) - 1) * 100 : 0; return { balances: { denominatedAsset: gunbot_pair_format.split('-')[0], coinBalance: formatCoin(quoteBalance), bagValue: `$${formatCurrency(pairRecord?.bagSize)}`, denominatedBalance: `$${formatCurrency(baseBalance)}`, onBuyOrdersValue: `$${formatCurrency(onBuyOrdersValue)}`, onSellOrdersValue: `$${formatCurrency(onSellOrdersValue)}`, drawdown: pairRecord?.drawdown || 0, }, totalReturn }; }, [selectedPairData, tableRecords, equityChartData, assumedCapital, selectedPairKey]);

  if (isStatusLoading && !statusData) return <Center h="80vh"><Loader /></Center>;

  const renderRunActions = () => {
    if (confirmation === 'discovery') {
      return (
        <Paper withBorder p="md" radius="md">
            <Stack gap="md">
                <Title order={5}>Configure Pair Discovery</Title>
                <Text size="sm" c="dimmed">This job scans for high-quality alternative pairs by running a universal benchmark. This process can take 10-20 minutes.</Text>
                
                <Select
                  label="Analysis Timeframe"
                  data={AVAILABLE_TIMEFRAMES_FOR_ANALYSIS}
                  value={discoveryTimeframe}
                  onChange={setDiscoveryTimeframe}
                />
                
                <SegmentedControl
                  fullWidth
                  value={discoveryDateType}
                  onChange={setDiscoveryDateType}
                  data={[
                    { label: 'Active Pair Time', value: 'active_pair_time' },
                    { label: 'Custom Range', value: 'custom_range' },
                  ]}
                />
                {discoveryDateType === 'custom_range' && (
                    <Stack gap="xs">
                        <DatePickerInput type="range" label="Select Date Range" value={discoveryDateRange} onChange={setDiscoveryDateRange} />
                        <Group gap="xs">
                            <Button size="xs" variant="light" onClick={() => setDiscoveryDatePreset(7)}>Last 7d</Button>
                            <Button size="xs" variant="light" onClick={() => setDiscoveryDatePreset(30)}>Last 30d</Button>
                            <Button size="xs" variant="light" onClick={() => setDiscoveryDatePreset(90)}>Last 90d</Button>
                        </Group>
                    </Stack>
                )}
                <NumberInput
                  label="Number of Pairs to Scan"
                  description={`Top N by volume on the ${detailData.balances.denominatedAsset} market`}
                  value={discoveryCandidateCount}
                  onChange={setDiscoveryCandidateCount}
                  min={10} max={500} step={10} allowDecimal={false} thousandSeparator
                />
                <NumberInput
                  label="Minimum Daily Volume"
                  description="Filter out pairs below this average daily volume"
                  value={discoveryMinDailyVolume}
                  onChange={setDiscoveryMinDailyVolume}
                  min={1000} step={100000} thousandSeparator prefix="$"
                />
              <Group justify="flex-end" mt="md">
                <Button variant="default" onClick={() => setConfirmation(null)}>Cancel</Button>
                <Button onClick={handleFindBetterPairConfirm} disabled={!discoveryCandidateCount || !discoveryMinDailyVolume}>Confirm & Start</Button>
              </Group>
            </Stack>
        </Paper>
      );
    }

    if (confirmation === 'benchmark') {
       return (
        <Paper withBorder p="md" radius="md">
            <Stack gap="md">
                <Title order={5}>Configure Benchmark</Title>
                <Text size="sm" c="dimmed">Benchmark <strong>{selectedPairData?.standard_pair_format}</strong> against all library strategies to see how it could perform.</Text>
                <MultiSelect
                  data={AVAILABLE_TIMEFRAMES_FOR_ANALYSIS}
                  value={timeframesToTest}
                  onChange={setTimeframesToTest}
                  label="Timeframes to Test"
                  placeholder="Select at least one"
                />
                <SegmentedControl
                  fullWidth
                  value={benchmarkDateType}
                  onChange={setBenchmarkDateType}
                  data={[
                    { label: 'Active Pair Time', value: 'active_pair_time' },
                    { label: 'Custom Range', value: 'custom_range' },
                  ]}
                />
                {benchmarkDateType === 'custom_range' && (
                    <Stack gap="xs">
                        <DatePickerInput type="range" label="Select Date Range" value={benchmarkDateRange} onChange={setBenchmarkDateRange} />
                        <Group gap="xs">
                            <Button size="xs" variant="light" onClick={() => setBenchmarkDatePreset(7)}>Last 7d</Button>
                            <Button size="xs" variant="light" onClick={() => setBenchmarkDatePreset(30)}>Last 30d</Button>
                            <Button size="xs" variant="light" onClick={() => setBenchmarkDatePreset(90)}>Last 90d</Button>
                        </Group>
                    </Stack>
                )}
              <Group justify="flex-end" mt="md">
                <Button variant="default" onClick={() => setConfirmation(null)}>Cancel</Button>
                <Button onClick={handleRunBenchmarkConfirm} disabled={timeframesToTest.length === 0}>Confirm & Start</Button>
              </Group>
            </Stack>
        </Paper>
      );
    }
    
    return (
      <>
        {job.status === 'completed' && job.id && (
          <Button size="xs" variant="gradient" gradient={{from: 'teal', to: 'lime'}} leftSection={<IconHistory size={14} />} onClick={handleViewReport} mb="sm" fullWidth>
              View Last Report
          </Button>
        )}
        <Group grow>
            <MantineTooltip label="Run a backtest on this pair's symbol against all available strategies." withArrow multiline w={280}>
                <Button
                    size="xs" variant="filled"
                    onClick={() => setConfirmation('benchmark')}
                    loading={job.status === 'running' && job.type === 'benchmark'}
                    disabled={job.status === 'running' || !selectedPairData?.orders?.length}
                    leftSection={<IconTestPipe size={14} />}
                >
                    Run Benchmark
                </Button>
            </MantineTooltip>
            <MantineTooltip label="Search the exchange for alternative, potentially more profitable pairs." withArrow multiline w={280}>
                <Button 
                    size="xs" variant="default" 
                    onClick={() => setConfirmation('discovery')}
                    loading={job.status === 'running' && job.type === 'discovery'}
                    disabled={job.status === 'running' || !selectedPairData?.orders?.length}
                    leftSection={<IconZoomCode size={14} />}
                >
                  Find Better Pair
                </Button>
            </MantineTooltip>
        </Group>
      </>
    );
  };
  
  const ConnectionStatus = () => {
    let icon, color, text;
    if (isStatusError || statusData?.status === 'error') {
        icon = <IconCircleX />; color = 'red'; text = statusData?.message || 'Connection error';
    } else if (isStatusLoading && !statusData) {
        icon = <Loader size="xs" />; color = 'gray'; text = 'Connecting...';
    } else if (!isConnected) {
        icon = <IconPlugConnectedX />; color = 'orange'; text = 'Not Connected';
    } else {
        switch (statusData.status) {
            case 'active': icon = <IconPlayerPlay />; color = 'green'; break;
            case 'idle': icon = <IconPlayerPause />; color = 'yellow'; break;
            case 'starting': icon = <IconClockHour4 />; color = 'cyan'; break;
            default: icon = <IconPlugConnected />; color = 'blue';
        }
        text = statusData.message;
    }
    return (
        <Group>
            <MantineTooltip label={text} withArrow>
                <div>
                    <ThemeIcon color={color} size={24} radius="xl">{icon}</ThemeIcon>
                </div>
            </MantineTooltip>
            <div>
                <Text fw={500} tt="capitalize">{statusData?.status || 'Disconnected'}</Text>
                <Text size="xs" c="dimmed">{text}</Text>
            </div>
        </Group>
    );
  };

  return (
    <Stack gap="lg">
      <SafeModal opened={removeModalOpened} onClose={closeRemoveModal} size="md">
        <Group justify="space-between" mb="md">
          <Title order={4}>Confirm Removal</Title>
          <ActionIcon variant="subtle" onClick={closeRemoveModal}>
            <IconX size={18} />
          </ActionIcon>
        </Group>
        <Stack>
            <Text>Are you sure you want to remove the pair <Code>{pairToRemove?.gunbot_pair_format}</Code> from the <Code>{pairToRemove?.exchange}</Code> exchange in Gunbot?</Text>
            <Text c="dimmed" size="sm">This will disable the pair in your Gunbot configuration but will not sell any assets.</Text>
            <Group justify="flex-end" mt="xl">
                <Button variant="default" onClick={closeRemoveModal}>Cancel</Button>
                <Button color="red" onClick={handleConfirmRemove} loading={removePairMutation.isPending}>Remove Pair</Button>
            </Group>
        </Stack>
      </SafeModal>

      <Group justify="space-between"><div><Title order={2}>Gunbot Tools</Title><Text c="dimmed" size="sm">Connect your bot, analyze live performance, and find new opportunities. </Text></div><MantineTooltip label="Show help and usage instructions" withArrow><ActionIcon variant="subtle" onClick={() => setShowHelp(o => !o)}><IconInfoCircle size={20} /></ActionIcon></MantineTooltip></Group>
      <Collapse in={showHelp} transitionDuration={200}><Alert icon={<IconInfoCircle size="1rem" />} title="Quick Guide" color="blue" variant="light" withCloseButton onClose={() => setShowHelp(false)}><List size="sm" spacing="xs"><List.Item>📈 The <strong>Active Pairs Overview</strong> table updates every minute. Click any row to open its detailed analytics.</List.Item><List.Item>💰 The <strong>Performance Chart</strong> shows an equity curve. Set an "Assumed Initial Capital" to see how your pair has performed.</List.Item><List.Item>🚀 <strong>Run Benchmark</strong> backtests the current pair's symbol against a library of trading strategies. <strong>Find Better Pair</strong> searches for more profitable pairs on the same market.</List.Item><List.Item>🟢 <strong>Get Started:</strong> Connect to your <a href="https://www.gunbot.com" target="_blank" rel="noopener" style={{color: theme.colors.blue[4]}}>Gunbot</a> instance using your GUI password and `gunthy_wallet` key to begin streaming data.</List.Item></List></Alert></Collapse>
      
      {!isConnected && (
            <Paper withBorder p="xl" radius="md" bg="dark.6">
                <Grid gutter="xl" align="center">
                    <Grid.Col span={{ base: 12, lg: 5 }}>
                        <Stack align="center" ta="center">
                            <ThemeIcon variant="light" color="blue" size={60} radius="xl">
                                <IconRobot size={36} />
                            </ThemeIcon>
                            <Title order={3}>Unlock Gunbot Analysis Tools</Title>
                            <Text c="dimmed" maw={450}>
                                Connect your <a href="https://www.gunbot.com" target="_blank" rel="noopener" style={{color: theme.colors.blue[4]}}>Gunbot</a> instance to stream live trading data, access powerful analysis tools, and discover new opportunities for your trading bot. Requires a Gunbot Defi license.
                            </Text>
                        </Stack>
                    </Grid.Col>
                    <Grid.Col span={{ base: 12, lg: 7 }}>
                        <Stack>
                            <FeatureCard icon={IconChartAreaLine} title="Analyze Live Performance" description="Visualize the equity curve of your active trading pairs and compare them against a simple Buy & Hold strategy." />
                            <FeatureCard icon={IconTestPipe} color="teal" title="Run Benchmarks" description="How good is your current strategy? Backtest your live pair's symbol against a library of common strategies over the same period." />
                            <FeatureCard icon={IconZoomCode} color="yellow" title="Discover Better Pairs" description="Automatically scan the market for other pairs that might perform better." />
                        </Stack>
                    </Grid.Col>
                </Grid>
            </Paper>
      )}

      <Paper withBorder p="md" radius="md"><Group justify="space-between"><ConnectionStatus /><Button variant="default" size="xs" onClick={() => setShowConnectionSettings(o => !o)}>{showConnectionSettings ? 'Hide Settings' : 'Connection Settings'}</Button></Group>
      <Collapse in={showConnectionSettings || !isConnected } transitionDuration={200}><Stack mt="md"><Grid><Grid.Col span={{ base: 12, sm: 4 }}><MantineTooltip label="Choose the protocol used by your Gunbot web API (usually http unless you configured SSL)" withArrow multiline w={220}><Select label="Protocol" data={['http', 'https']} value={protocol} onChange={setProtocol} disabled={isConnected || connectMutation.isPending} /></MantineTooltip></Grid.Col><Grid.Col span={{ base: 12, sm: 5 }}><MantineTooltip label="Hostname or IP Address" withArrow><TextInput label="Host / IP Address" placeholder="localhost" value={host} onChange={(e) => setHost(e.currentTarget.value)} disabled={isConnected || connectMutation.isPending} /></MantineTooltip></Grid.Col><Grid.Col span={{ base: 12, sm: 3 }}><MantineTooltip label="TCP port configured for the Gunbot web server" withArrow><NumberInput label="Port" placeholder="3000" value={port} onChange={setPort} min={1} max={65535} allowDecimal={false} disabled={isConnected || connectMutation.isPending} /></MantineTooltip></Grid.Col></Grid>
      <TextInput label="Gunthy Wallet Key" description="Found in your Gunbot config.js file (config.bot.gunthy_wallet)" placeholder="Paste key here" leftSection={<IconWallet size={16} />} value={gunthyWallet} onChange={(e) => setGunthyWallet(e.currentTarget.value)} disabled={isConnected || connectMutation.isPending} />
      <PasswordInput label="Gunbot GUI Password" description="The same password you use to log in to the Gunbot GUI." placeholder="Enter password" leftSection={<IconKey size={16} />} value={password} onChange={(e) => setPassword(e.currentTarget.value)} disabled={isConnected || connectMutation.isPending} />
      <Group justify="flex-end">{isConnected && ( <Button color="red" variant="light" onClick={() => disconnectMutation.mutate()} loading={disconnectMutation.isPending} leftSection={<IconPlugConnectedX size={18} />}>Disconnect</Button> )}<Button onClick={handleConnect} loading={connectMutation.isPending} disabled={isConnected || !password.trim() || !gunthyWallet.trim() || !host.trim() || !port} leftSection={<IconServer size={18} />}>Save & Connect</Button></Group></Stack></Collapse></Paper>

      {isConnected && (
        <>
          {selectedPairData && (
            <Paper withBorder p="md" radius="md">
              <Stack gap="md">
                 <Group justify="space-between"><Breadcrumbs><Anchor component="button" type="button" onClick={() => setSelectedPairKey(null)} size="sm">Gunbot Tools</Anchor><Text size="sm" fw={500}>{selectedPairData.standard_pair_format}</Text></Breadcrumbs><MantineTooltip label="Close detail panel" withArrow><ActionIcon variant='subtle' onClick={() => setSelectedPairKey(null)}><IconX size={20} /></ActionIcon></MantineTooltip></Group>
                <Grid gutter="lg">
                  <Grid.Col span={{ base: 12, md: 7 }}><Stack gap="sm"><Group gap="xs"><Title order={4}>Performance Chart</Title><MantineTooltip withArrow label="Equity curve showing performance vs. Buy & Hold, based on the assumed initial capital." multiline w={260}><ThemeIcon variant="subtle" color="gray" radius="xl" size="xs"><IconInfoCircle /></ThemeIcon></MantineTooltip></Group><EquityChart data={equityChartData} theme={theme} /></Stack></Grid.Col>
                  <Grid.Col span={{ base: 12, md: 5 }}>
                    <Stack gap="md">
                      <div><Title order={5} mb="sm">Live Balances & State</Title><SimpleGrid cols={2} spacing="sm"><StatTile label="Coin Balance" value={detailData.balances.coinBalance} color={theme.colors.gray[4]} tooltip="Amount of the quote coin (e.g., ETH) currently in your wallet" /><StatTile label="Bag Value" value={detailData.balances.bagValue} color={theme.colors.gray[4]} tooltip="Value of the coin balance at its average acquisition price (unit cost)" /><StatTile label={`${detailData.balances.denominatedAsset} Balance`} value={detailData.balances.denominatedBalance} color={theme.colors.gray[4]} tooltip={`Amount of ${detailData.balances.denominatedAsset} currently available in account`} /><StatTile label="Unrealised PnL / DD" value={detailData.balances.drawdown.toFixed(2)} suffix="%" color={detailData.balances.drawdown >= 0 ? 'teal' : 'red'} tooltip="Current profit or loss of held coins compared to their average cost" /><StatTile label="On Buy Orders" value={detailData.balances.onBuyOrdersValue} color={theme.colors.cyan[5]} tooltip="Capital reserved in open buy orders" /><StatTile label="On Sell Orders" value={detailData.balances.onSellOrdersValue} color={theme.colors.pink[5]} tooltip="Coin value locked in open sell orders" /><StatTile label="Strategy Return" value={detailData.totalReturn.toFixed(2)} suffix="%" color={detailData.totalReturn >= 0 ? 'green' : 'red'} tooltip="Total return based on assumed capital" /><StatTile label="Candle TF" value={formatTimeframe(selectedPairData.candleTimeFrame)} color={theme.colors.gray[4]} tooltip="Timeframe used for strategy candles (e.g. 15m, 1h, 1d)" /></SimpleGrid></div>
                      <div><UnstyledButton onClick={() => setShowConfig(o => !o)} w="100%"><Group justify="space-between"><Title order={5}>Strategy Configuration</Title><IconChevronDown size={16} style={{ transform: showConfig ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} /></Group></UnstyledButton><Collapse in={showConfig} transitionDuration={150}><Paper withBorder p="sm" mt="xs" radius="sm"><ScrollArea h={120} type="auto"><Table withRowBorders={false} verticalSpacing="xs" fz="xs"><Table.Tbody>{selectedPairData.config?.override && Object.entries(selectedPairData.config.override).map(([key, value]) => ( <Table.Tr key={key}><Table.Td c="dimmed" p={0}>{key}</Table.Td><Table.Td p={0}><Text fw={500} ta="right">{String(value)}</Text></Table.Td></Table.Tr> ))}</Table.Tbody></Table></ScrollArea></Paper></Collapse></div>
                      <NumberInput label="Assumed Initial Capital" description="For equity curve calculation" value={assumedCapital} onChange={handleCapitalChange} min={1} step={100} thousandSeparator />
                      <Stack gap="sm">
                          <Title order={5}>Run Actions</Title>
                          {renderRunActions()}
                      </Stack>
                    </Stack>
                  </Grid.Col>
                </Grid>
              </Stack>
            </Paper>
          )}

          <Paper withBorder radius="md" p="md">
              <Group justify="space-between" mb="md">
                <div><Title order={4}>Active Pairs Overview</Title><Text size="sm" c="dimmed">Click a row to view details and run benchmarks.</Text></div>
                <MantineTooltip label="Force an immediate data refresh from Gunbot" withArrow><Button onClick={handleRefresh} size="xs" variant="default" leftSection={<IconRefresh size={14} />} loading={isRefetching}>Refresh</Button></MantineTooltip>
              </Group>
              {(isDataLoading && !isRefetching) && <Center p="xl"><Loader /></Center>}
              {dataError && <Alert color="red" title="Error Loading Data" icon={<IconCircleX />}>{dataError.message}</Alert>}
              {tradingPairs && ( 
                <DataTable
                  minHeight={tableRecords.length > 0 ? 300 : 150}
                  withTableBorder borderRadius="sm" striped highlightOnHover
                  verticalBreakpoint="sm"
                  records={tableRecords} idAccessor="id"
                  onRowClick={({ record }) => setSelectedPairKey(record.id === selectedPairKey ? null : record.id)}
                  rowClassName={({ id }) => id === selectedPairKey ? 'mantine-datatable-row-highlight' : ''}
                  columns={[
                     { accessor: 'standard_pair_format', title: <Text fw={600}>Pair</Text>, width: 100, render: ({ standard_pair_format: p, exchange: e }) => ( <Stack gap={0}><Text size="sm" fw={500}>{p}</Text><Text size="xs" c="dimmed">{e}</Text></Stack> ), },
                     { accessor: 'gq_exchange', title: <Text fw={600}>Benchmark On</Text>, width: 150, render: ({ standard_pair_format }) => { const normData = normalizationCache[standard_pair_format]; if ((isNormalizing && !normData) || (isDataLoading && !normData)) return <Loader size="xs" />; if (!normData) return <Text size="xs" c="dimmed">—</Text>; return ( <MantineTooltip label={normData.warning} disabled={!normData.warning} withArrow multiline w={250} position="top-start"><span><Text size="sm" tt="capitalize">{normData.gq_exchange}</Text></span></MantineTooltip> ); }, },
                     { accessor: 'config.strategy', title: <Text fw={600}>Strategy</Text>, width: 130 },
                     { accessor: 'history', title: <Text fw={600}>History</Text>, render: ({ pnlHistory, ddHistory }) => ( <Stack gap={0}><MantineTooltip label="Realised PnL trend" withArrow><span><Sparkline data={pnlHistory} color={theme.colors.teal[4]} /></span></MantineTooltip><MantineTooltip label="Drawdown at trade time" withArrow><span><Sparkline data={ddHistory} color={theme.colors.yellow[6]} /></span></MantineTooltip></Stack> ), },
                     { accessor: 'bagSize', title: <Text fw={600}>Bag Size</Text>, textAlignment: 'right', render: ({ bagSize }) => `$${formatCurrency(bagSize)}`, },
                     { accessor: 'drawdown', title: <Text fw={600}>DD %</Text>, textAlignment: 'right', render: ({ drawdown: dd }) => <Text size="sm" c={dd >= 0 ? 'teal' : 'red'}>{dd.toFixed(2)}%</Text>, },
                     { accessor: 'realizedPnl', title: <Text fw={600}>Realized PnL</Text>, textAlignment: 'right', render: ({ realizedPnl }) => <Text size="sm" fw={500} c={realizedPnl > 0 ? 'teal' : realizedPnl < 0 ? 'red' : 'dimmed'}>${formatCurrency(realizedPnl)}</Text> },
                     { accessor: 'openOrders.length', title: <Text fw={600}>Open</Text>, textAlignment: 'center' },
                     { accessor: 'candleTimeFrame', title: <Text fw={600}>TF</Text>, textAlignment: 'center', width: 80, render: ({ candleTimeFrame }) => ( <Text size="sm" c="dimmed">{formatTimeframe(candleTimeFrame)}</Text> ) },
                     { accessor: 'actions', title: <Text fw={600}>Actions</Text>, textAlignment: 'right', width: 100,
                       render: (pair) => (
                         <Group gap="xs" justify="flex-end" wrap="nowrap">
                           <MantineTooltip label="Remove Pair from Gunbot">
                             <ActionIcon color="red" variant="subtle" onClick={(e) => { e.stopPropagation(); handleRemoveClick(pair); }}>
                               <IconTrash size={16} />
                             </ActionIcon>
                           </MantineTooltip>
                         </Group>
                       ),
                     },
                  ]}
                  noRecordsText="No actively trading pairs found in Gunbot."
                /> 
              )}
          </Paper>
        </>
      )}
    </Stack>
  );
} 
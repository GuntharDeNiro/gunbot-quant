/* eslint react/prop-types: 0 */
import { useState, useEffect, useRef } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Collapse,
  Divider,
  Grid,
  Group,
  List,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconDeviceFloppy,
  IconFileSearch,
  IconInfoCircle,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
  IconBuildingStore,
} from '@tabler/icons-react';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import ScreenerResultsDisplay from './ScreenerResultsDisplay';
import ScreenerResultsSkeleton from './ScreenerResultsSkeleton';

/* ──────────────────────────────────────────
   STATIC SELECT DATA
   ────────────────────────────────────────── */
const availableConditions = [
  { value: 'greater_than', label: '>' },
  { value: 'less_than', label: '<' },
  { value: 'between', label: 'between' },
];

const screenerTimeframes = [
  { value: '1m', label: '1 Minute' },
  { value: '3m', label: '3 Minutes' },
  { value: '5m', label: '5 Minutes' },
  { value: '15m', label: '15 Minutes' },
  { value: '30m', label: '30 Minutes' },
  { value: '1h', label: '1 Hour' },
  { value: '2h', label: '2 Hours' },
  { value: '4h', label: '4 Hours' },
  { value: '6h', label: '6 Hours' },
  { value: '12h', label: '12 Hours' },
  { value: '1d', label: '1 Day' },
  { value: '3d', label: '3 Days' },
];

/* ──────────────────────────────────────────
   COMPONENT
   ────────────────────────────────────────── */
export default function Screener({ onAddPair }) {
  const theme = useMantineTheme();

  /* ─────── runtime state ─────── */
  const [jobStatus, setJobStatus] = useState('idle');   // idle | running | completed | failed
  const [jobError, setJobError] = useState(null);
  const [results, setResults] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const pollingRef = useRef(null);

  /* dynamic select data */
  const [availableMarkets, setAvailableMarkets] = useState([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [availableMetrics, setAvailableMetrics] = useState([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [availableExchanges, setAvailableExchanges] = useState([]);
  const [exchangesLoading, setExchangesLoading] = useState(true);


  /* UI toggles */
  const [showHelp, setShowHelp] = useState(false);

  /* ─────── helpers ─────── */
  const metricMeta = Object.fromEntries(availableMetrics.map((m) => [m.value, m]));
  const metricSelectData = availableMetrics.map((m) => ({ value: m.value, label: m.label }));

  /* ─────── form ─────── */
  const form = useForm({
    initialValues: {
      job_name: `Screen-${dayjs().format('YYYY-MM-DD_HH-mm-ss')}`,
      exchange: 'binance',
      quote_asset: 'USDT',
      timeframe: '1d',
      candidate_count: 200,
      final_count: 20,
      rank_metric: 'roc_30p',
      filters: [
        { metric: 'avg_vol_30d_quote', condition: 'greater_than', value: '10000000' },
        { metric: 'atr_pct_14p', condition: 'between', value: '2, 10' },
        { metric: 'stochrsi_k_14_3_3', condition: 'less_than', value: '20' },
      ],
      symbols: ['SPY', 'QQQ', 'TSLA', 'AAPL', 'MSFT'], // For yfinance
    },
    validate: (values) => {
        const errors = {};
        if (!values.job_name.trim()) errors.job_name = 'Required';
        
        if (values.exchange !== 'yfinance') {
            if (!values.quote_asset) errors.quote_asset = 'Required';
            if (!(values.candidate_count > 0 && values.candidate_count <= 500)) errors.candidate_count = '1-500';
            if (!(values.final_count > 0 && values.final_count <= 50)) errors.final_count = '1-50';
        } else {
            if (!values.symbols || values.symbols.length === 0) errors.symbols = 'At least one ticker is required for Yahoo Finance';
        }
        return errors;
    },
  });

  /* ─────── async fetches ─────── */
  useEffect(() => {
     const fetchExchanges = async () => {
      setExchangesLoading(true);
      try {
        const resp = await fetch('/api/v1/exchanges');
        if (!resp.ok) throw new Error('Could not load exchange list');
        setAvailableExchanges(await resp.json());
      } catch (err) {
        notifications.show({ title: 'Error Loading Exchanges', message: err.message, color: 'red' });
      } finally {
        setExchangesLoading(false);
      }
    };

    const fetchMetrics = async () => {
      setMetricsLoading(true);
      try {
        const resp = await fetch(`/api/v1/screen/metrics?exchange=${form.values.exchange}`);
        if (!resp.ok) throw new Error('Could not load metrics');
        setAvailableMetrics(await resp.json());
      } catch (err) {
        notifications.show({
          title: 'Error',
          message: err.message,
          color: 'red',
          icon: <IconAlertCircle />,
        });
      } finally {
        setMetricsLoading(false);
      }
    };

    fetchExchanges();
    fetchMetrics();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.exchange]);

  useEffect(() => {
    const selectedExchange = form.values.exchange;
    if (!selectedExchange || selectedExchange === 'yfinance') {
        setAvailableMarkets([]);
        setMarketsLoading(false);
        return;
    };

    const fetchMarkets = async () => {
      setMarketsLoading(true);
      try {
        const resp = await fetch(`/api/v1/markets/${selectedExchange}`);
        if (!resp.ok) throw new Error(`Could not load markets for ${selectedExchange}`);
        const markets = await resp.json();
        setAvailableMarkets(markets);
        if (!markets.includes(form.values.quote_asset)) {
          form.setFieldValue('quote_asset', markets.find(m => m === 'USDT') || markets[0] || '');
        }
      } catch (err) {
        notifications.show({ title: 'Error Loading Markets', message: err.message, color: 'red' });
        setAvailableMarkets(['USDT', 'BTC']); // Fallback
      } finally {
        setMarketsLoading(false);
      }
    };

    fetchMarkets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.exchange]);

  /* ─────── job helpers ─────── */
  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  const checkJobStatus = async (jobId) => {
    try {
      const response = await fetch(`/api/v1/screen/status/${jobId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Failed to fetch status');

      if (data.status === 'completed') {
        setJobStatus('completed');
        setResults(data.report);
        notifications.show({
          title: 'Screener completed',
          message: `Results for ${jobId} are ready`,
          color: 'green',
          icon: <IconCheck />,
        });
        stopPolling();
      } else if (data.status === 'failed') {
        setJobStatus('failed');
        setJobError(data.report?.details || data.report?.error || 'Job failed');
        notifications.show({
          title: 'Screener failed',
          message: data.report?.error || 'Error while screening',
          color: 'red',
          icon: <IconAlertCircle />,
          autoClose: 10000
        });
        stopPolling();
      }
    } catch (err) {
      setJobStatus('failed');
      setJobError(err.message);
      stopPolling();
    }
  };

  /* util to clean form values */
  const getSanitizedConfig = (values) => {
    const formattedFilters = values.filters
      .map((f) => {
        if (!f.metric || !f.condition || !f.value) return null;
        let parsedValue;
        if (f.condition === 'between') {
          parsedValue = f.value
            .split(',')
            .map((v) => parseFloat(v.trim()))
            .filter((v) => !Number.isNaN(v));
          if (parsedValue.length !== 2) return null;
        } else {
          parsedValue = parseFloat(f.value);
          if (Number.isNaN(parsedValue)) return null;
        }
        return { ...f, value: parsedValue };
      })
      .filter(Boolean);
    
    const config = {
        exchange: values.exchange,
        timeframe: values.timeframe,
        rank_metric: values.rank_metric,
        filters: formattedFilters,
    };

    if (values.exchange === 'yfinance') {
        config.symbols = values.symbols;
        config.quote_asset = 'USD'; // Implied for stocks
    } else {
        config.quote_asset = values.quote_asset;
        config.candidate_count = values.candidate_count;
        config.final_count = values.final_count;
    }
    return config;
  };

  /* run screener */
  const runScreener = (values) => {
    setJobStatus('running');
    setResults(null);
    setJobError(null);

    const body = { job_name: values.job_name, config: getSanitizedConfig(values) };

    fetch('/api/v1/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Failed to start job');
        }
        return res.json();
      })
      .then((data) => {
        notifications.show({
          title: 'Screener started',
          message: `Job '${values.job_name}' is running`,
          color: 'blue',
        });
        const checker = () => checkJobStatus(data.job_id);
        if (pollingRef.current) clearInterval(pollingRef.current);
        pollingRef.current = setInterval(checker, 5000);
        setTimeout(checker, 1000);
      })
      .catch((err) => {
        setJobStatus('failed');
        setJobError(err.message);
        notifications.show({
          title: 'Error',
          message: err.message,
          color: 'red',
          icon: <IconX />,
        });
      });
  };

  /* save config */
  const saveConfig = (values) => {
    setIsSaving(true);
    const cfgName = values.job_name;
    const cfgBody = getSanitizedConfig(values);

    fetch(`/api/v1/screen/configs/${cfgName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfgBody),
    })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Failed to save');
        }
        return res.json();
      })
      .then(() => {
        notifications.show({
          title: 'Saved',
          message: `Config '${cfgName}' stored`,
          color: 'green',
          icon: <IconCheck />,
        });
      })
      .catch((err) => {
        notifications.show({
          title: 'Error',
          message: err.message,
          color: 'red',
          icon: <IconX />,
        });
      })
      .finally(() => setIsSaving(false));
  };

  /* ─────── custom render helpers ─────── */
  const renderMetricOption = ({ option }) => {
    const meta = metricMeta[option.value];
    return (
      <Stack gap={2} p={2}>
        <Text size="sm">{option.label}</Text>
        {meta?.description && (
          <Text size="xs" c="dimmed" lh={1.2}>
            {meta.description}
          </Text>
        )}
      </Stack>
    );
  };

  const filterRows = form.values.filters.map((item, idx) => {
    const meta = metricMeta[item.metric];
    return (
      <Paper key={idx} withBorder radius="sm" p="sm">
        <Grid gutter="xs" align="flex-end">
          <Grid.Col span={4}>
            <Select
              label={idx === 0 ? 'Metric' : null}
              placeholder={metricsLoading ? 'Loading…' : 'Metric'}
              data={metricSelectData}
              searchable
              disabled={metricsLoading}
              renderOption={renderMetricOption}
              {...form.getInputProps(`filters.${idx}.metric`)}
            />
          </Grid.Col>
          <Grid.Col span={3}>
            <Select
              label={idx === 0 ? 'Cond' : null}
              data={availableConditions}
              {...form.getInputProps(`filters.${idx}.condition`)}
            />
          </Grid.Col>
          <Grid.Col span={4}>
            <TextInput
              label={idx === 0 ? 'Value' : null}
              placeholder={item.condition === 'between' ? '10, 50' : '25'}
              {...form.getInputProps(`filters.${idx}.value`)}
            />
          </Grid.Col>
          <Grid.Col span={1}>
            <ActionIcon
              color="red"
              mt={idx === 0 ? '1.5625rem' : 0}
              onClick={() => form.removeListItem('filters', idx)}
            >
              <IconTrash size="1rem" />
            </ActionIcon>
          </Grid.Col>
        </Grid>
        {meta?.description && (
          <Text size="xs" c="dimmed" mt={4}>
            {meta.description}
          </Text>
        )}
      </Paper>
    );
  });

  const renderResults = () => {
    if (jobStatus === 'idle') {
      return (
        <Center h={400}>
          <Stack align="center">
            <IconFileSearch size={46} color={theme.colors.gray[6]} />
            <Title order={3}>Ready to screen</Title>
            <Text c="dimmed" size="sm">
              Results will appear here.
            </Text>
          </Stack>
        </Center>
      );
    }
    if (jobStatus === 'running') return <ScreenerResultsSkeleton />;
    if (jobStatus === 'failed') {
      return (
        <Alert color="red" title="Error" icon={<IconAlertCircle />}>
          {jobError}
        </Alert>
      );
    }
    if (jobStatus === 'completed' && results) {
        return <ScreenerResultsDisplay report={results} onAddPair={onAddPair} />;
    }
    return null;
  };

  /* ──────────────────────────────────────────
     JSX
     ────────────────────────────────────────── */
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={2}>Market Screener</Title>
        <Tooltip label="Show guide">
          <ActionIcon variant="subtle" onClick={() => setShowHelp((o) => !o)}>
            <IconInfoCircle size={20} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Collapse in={showHelp} mb="md">
        <Alert
          icon={<IconInfoCircle size="1rem" />}
          variant="outline"
          color="blue"
          title="How to Use the Market Screener"
        >
          <List size="sm" spacing="xs">
            <List.Item>
              <b>Scan Crypto Markets:</b> Choose an exchange, timeframe, and asset. The screener fetches top symbols by volume to analyze.
            </List.Item>
            <List.Item>
              <b>Analyze Stocks & ETFs:</b> Select "Yahoo Finance" and provide a manual list of tickers (e.g., SPY, AAPL) to run the same analysis.
            </List.Item>
            <List.Item>
              <b>Define Filters:</b> Build a set of rules using technical indicators to narrow down the candidates to only the most promising assets.
            </List.Item>
            <List.Item>
              <b>Save for Backtesting:</b> You can save any screener setup and use it as an automatic symbol source in the Backtest Lab.
            </List.Item>
          </List>
        </Alert>

      </Collapse>

      <Grid gutter="xl">
        {/* ───── CONFIG COLUMN ───── */}
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Paper withBorder p="md" radius="md">
            <ScrollArea h="calc(90vh - 160px)">
              <form>
                <Stack gap="sm">
                  <Title order={4}>Run configuration</Title>
                  <TextInput
                    label="Run label"
                    required
                    {...form.getInputProps('job_name')}
                  />
                  <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                    <Select
                      label="Data Source"
                      data={availableExchanges}
                      searchable
                      disabled={exchangesLoading}
                      placeholder={exchangesLoading ? 'Loading...' : 'Select exchange'}
                      leftSection={<IconBuildingStore size={16} />}
                      {...form.getInputProps('exchange')}
                    />

                    {form.values.exchange !== 'yfinance' ? (
                      <Select
                        label="Denominated in"
                        data={availableMarkets}
                        disabled={marketsLoading || form.values.exchange === 'yfinance'}
                        placeholder={marketsLoading ? 'Loading...' : 'e.g. USDT'}
                        searchable
                        {...form.getInputProps('quote_asset')}
                      />
                    ) : (
                      <Box /> // Empty box to maintain grid layout
                    )}

                    <Select
                      label="Timeframe"
                      description="Candle size"
                      data={screenerTimeframes}
                      {...form.getInputProps('timeframe')}
                    />

                    {form.values.exchange !== 'yfinance' && (
                        <NumberInput
                          label="Candidates"
                          description="Top N by volume"
                          {...form.getInputProps('candidate_count')}
                        />
                    )}
                    
                    {form.values.exchange !== 'yfinance' && (
                        <NumberInput
                          label="Final count"
                          description="Top N ranked"
                          {...form.getInputProps('final_count')}
                        />
                    )}

                    <Select
                      label="Rank metric"
                      description="Criterium to rank results"
                      searchable
                      disabled={metricsLoading}
                      data={metricSelectData}
                      renderOption={renderMetricOption}
                      {...form.getInputProps('rank_metric')}
                    />
                  </SimpleGrid>

                  {form.values.exchange === 'yfinance' && (
                    <TagsInput
                        mt="xs"
                        label="Tickers to Analyze"
                        description="Enter stock/ETF tickers (e.g., SPY, AAPL)"
                        placeholder="Press Enter to add"
                        {...form.getInputProps('symbols')}
                    />
                  )}

                  <Divider label="Filters" mt="sm" />
                  {filterRows}
                  <Group justify="flex-end" mt="xs">
                    <Button
                      variant="default"
                      size="xs"
                      leftSection={<IconPlus size={14} />}
                      onClick={() =>
                        form.insertListItem('filters', {
                          metric: '',
                          condition: 'greater_than',
                          value: '',
                        })
                      }
                    >
                      Filter
                    </Button>
                  </Group>

                  <Divider mt="sm" />

                  <Group grow>
                    <Button
                      variant="outline"
                      loading={isSaving}
                      leftSection={<IconDeviceFloppy size={18} />}
                      onClick={() => form.onSubmit(saveConfig)()}
                    >
                      Save
                    </Button>
                    <Button
                      loading={jobStatus === 'running'}
                      leftSection={<IconSearch size={18} />}
                      onClick={() => form.onSubmit(runScreener)()}
                    >
                      Run
                    </Button>
                  </Group>
                </Stack>
              </form>
            </ScrollArea>
          </Paper>
        </Grid.Col>

        {/* ───── RESULTS COLUMN ───── */}
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Card withBorder radius="md" p="md" h="calc(90vh - 120px)" style={{minHeight: '85vh', display: 'flex', flexDirection: 'column'}}>
            <ScrollArea h="100%">
                {renderResults()}
            </ScrollArea>
          </Card>
        </Grid.Col>
      </Grid>
    </>
  );
}
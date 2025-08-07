/* eslint react/prop-types: 0 */
import { useState, useEffect, useRef } from 'react';
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Code,
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
import { DatePickerInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconCheck,
  IconInfoCircle,
  IconList,
  IconPlaystationCircle,
  IconPlus,
  IconReportAnalytics,
  IconTrash,
  IconZoomCode,
  IconBuildingStore,
} from '@tabler/icons-react';
import { randomId } from '@mantine/hooks';
import dayjs from 'dayjs';

import ResultsDisplay from './ResultsDisplay';
import ResultsSkeleton from './ResultsSkeleton';

/* ──────────────────────────────────────────
   STATIC SELECT DATA
   ────────────────────────────────────────── */
const availableTimeframes = [
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

const selectionMethods = [
  { value: 'EXPLICIT_LIST', label: 'Manual Symbol List' },
  { value: 'FROM_CONFIG', label: 'From a Saved Screener' },
];

/* helper for strategy params */
function ParamInput({ form, path, paramKey, pDef }) {
  if (pDef.type === 'float') {
    return (
      <NumberInput
        label={pDef.label}
        min={pDef.min}
        max={pDef.max}
        step={pDef.step}
        {...form.getInputProps(`${path}.${paramKey}`)}
      />
    );
  }
  return (
    <NumberInput
      label={pDef.label}
      min={pDef.min}
      max={pDef.max}
      step={1}
      allowDecimal={false}
      {...form.getInputProps(`${path}.${paramKey}`)}
    />
  );
}

/* ──────────────────────────────────────────
   COMPONENT
   ────────────────────────────────────────── */
export default function Backtester({ onAddPair }) {
  const theme = useMantineTheme();

  /* runtime state */
  const [jobStatus, setJobStatus] = useState('idle'); // idle | running | completed | failed
  const [jobError, setJobError] = useState(null);
  const [results, setResults] = useState(null);
  const pollingRef = useRef(null);

  const [strategyMeta, setStrategyMeta] = useState({});
  const [availableStrategies, setAvailableStrategies] = useState([]);
  const [strategiesLoading, setStrategiesLoading] = useState(true);
  const [selectedStrategyToAdd, setSelectedStrategyToAdd] = useState(null);

  // MODIFIED: State for dynamic exchange and market lists
  const [availableExchanges, setAvailableExchanges] = useState([]);
  const [exchangesLoading, setExchangesLoading] = useState(true);


  const [screenerConfigs, setScreenerConfigs] = useState([]);
  const [configsLoading, setConfigsLoading] = useState(true);

  /* UI toggles */
  const [showHelp, setShowHelp] = useState(false);
  const [resultsExpanded, setResultsExpanded] = useState(false);

  /* ─────── form ─────── */
  const form = useForm({
    initialValues: {
      scenario_name: `Run-${dayjs().format('YYYY-MM-DD_HH-mm')}`,
      exchange: 'binance',
      initial_capital: 10000,
      timeframe: '1h',
      dateRange: [dayjs().subtract(1, 'year').toDate(), new Date()],
      strategies: [],
      selection_method: 'EXPLICIT_LIST',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      screener_config_name: null,
    },
    validate: (values) => ({
      scenario_name: values.scenario_name.trim().length > 0 ? null : 'Required',
      initial_capital: values.initial_capital > 0 ? null : 'Must be positive',
      dateRange: values.dateRange[0] && values.dateRange[1] ? null : 'Pick dates',
      strategies: values.strategies.length > 0 ? null : 'Add at least one strategy',
      symbols:
        values.selection_method === 'EXPLICIT_LIST' && values.symbols.length === 0
          ? 'Add symbols'
          : null,
      screener_config_name:
        values.selection_method === 'FROM_CONFIG' && !values.screener_config_name
          ? 'Select config'
          : null,
    }),
  });

  /* ─────── fetch meta ─────── */
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

    const fetchStrategies = async () => {
      setStrategiesLoading(true);
      try {
        const resp = await fetch('/api/v1/strategies');
        if (!resp.ok) throw new Error('Could not load strategy list');
        const data = await resp.json();
        const meta = {};
        const selectData = data.map((s) => {
          meta[s.value] = s;
          return { value: s.value, label: s.label, ...s };
        });
        setStrategyMeta(meta);
        setAvailableStrategies(selectData);
        if (selectData.length > 0) setSelectedStrategyToAdd(selectData[0].value);
      } catch (err) {
        notifications.show({ title: 'Error', message: err.message, color: 'red', icon: <IconAlertCircle /> });
      } finally {
        setStrategiesLoading(false);
      }
    };

    const fetchConfigs = async () => {
      setConfigsLoading(true);
      try {
        const resp = await fetch('/api/v1/screen/configs');
        if (!resp.ok) throw new Error('Could not load screener configs');
        setScreenerConfigs(await resp.json());
      } catch (err) {
        notifications.show({ title: 'Error', message: err.message, color: 'red', icon: <IconAlertCircle /> });
      } finally {
        setConfigsLoading(false);
      }
    };

    fetchExchanges();
    fetchStrategies();
    fetchConfigs();
  }, []);

  /* build default params */
  const createStrategyObject = (meta) => {
    if (!meta) return null;
    const defaultParams = {};
    if (meta.params_def) {
      for (const [key, def] of Object.entries(meta.params_def)) {
        defaultParams[key] = def.default;
      }
    }
    return {
      id: randomId(),
      name: meta.value,
      alias: `${meta.label} #${form.values.strategies.length + 1}`,
      params: defaultParams,
    };
  };

  const handleAddStrategy = () => {
    const meta = strategyMeta[selectedStrategyToAdd];
    const obj = createStrategyObject(meta);
    if (obj) form.insertListItem('strategies', obj);
  };

  const handleAddAllStrategies = () => {
    form.setFieldValue('strategies', []);
    const newStrats = [];
    availableStrategies
      .forEach((meta) => {
        if (meta.is_legacy && form.values.exchange !== 'binance') return; // Don't add legacy for non-binance
        const params = {};
        if (meta.params_def) {
          for (const [key, def] of Object.entries(meta.params_def)) params[key] = def.default;
        }
        newStrats.push({
          id: randomId(),
          name: meta.value,
          alias: meta.label,
          params,
        });
      });
    form.setFieldValue('strategies', newStrats);
    notifications.show({
      title: 'Strategies added',
      message: `Added ${newStrats.length} strategies`,
      color: 'blue',
    });
  };

  /* ─────── polling helpers ─────── */
  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };
  useEffect(() => () => stopPolling(), []);

  const checkJobStatus = async (jobId) => {
    try {
      const resp = await fetch(`/api/v1/backtest/status/${jobId}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || 'Failed to fetch status');

      if (data.status === 'completed') {
        setJobStatus('completed');
        setResults(data.report);
        setResultsExpanded(true);
        notifications.show({
          title: 'Backtest completed',
          message: `Results for ${jobId} are ready`,
          color: 'green',
          icon: <IconCheck />,
        });
        stopPolling();
      } else if (data.status === 'failed') {
        setJobStatus('failed');
        setJobError(data.report?.details || data.report?.error || 'Job failed');
        notifications.show({
          title: 'Backtest failed',
          message: data.report?.error || 'An unexpected error occurred.',
          color: 'red',
          icon: <IconAlertCircle />,
          autoClose: 10000,
        });
        stopPolling();
      }
    } catch (err) {
      setJobStatus('failed');
      setJobError(err.message);
      stopPolling();
    }
  };

  /* run job */
  const runBacktest = async (values) => {
    setJobStatus('running');
    setResults(null);
    setJobError(null);
    setResultsExpanded(false);

    const body = {
      ...values,
      start_date: dayjs(values.dateRange[0]).format('YYYY-MM-DD'),
      end_date: dayjs(values.dateRange[1]).format('YYYY-MM-DD'),
      strategies: values.strategies.map(({ id, ...rest }) => rest),
    };
    delete body.dateRange;
    if (values.selection_method === 'EXPLICIT_LIST') delete body.screener_config_name;
    else delete body.symbols;

    try {
      const resp = await fetch('/api/v1/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail || 'Failed to start job');
      }
      const data = await resp.json();
      notifications.show({
        title: 'Backtest started',
        message: `Job '${values.scenario_name}' running`,
        color: 'blue',
      });
      const checker = () => checkJobStatus(data.job_id);
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(checker, 5000);
      setTimeout(checker, 1000);
    } catch (err) {
      setJobStatus('failed');
      setJobError(err.message);
      notifications.show({
        title: 'Error',
        message: err.message,
        color: 'red',
        icon: <IconAlertCircle />,
      });
    }
  };

  /* ─────── render helpers ─────── */
  const renderSelectOption = ({ option }) => {
    const meta = strategyMeta[option.value];
    if (!meta) return <div>{option.label}</div>;
    return (
      <Stack gap={2} p={2}>
        <Text size="sm">{meta.label}</Text>
        {meta.description && (
          <Text size="xs" c="dimmed" lh={1.2}>
            {meta.description}
          </Text>
        )}
      </Stack>
    );
  };

  const strategyForms = form.values.strategies.map((strat, idx) => {
    const meta = strategyMeta[strat.name] || {};
    const paramDefs = meta.params_def || {};
    const hasParams = Object.keys(paramDefs).length > 0;

    return (
      <Accordion.Item value={strat.id} key={strat.id}>
        <Accordion.Control>
          <Group justify="space-between" w="100%">
            <Text fw={500}>{strat.alias}</Text>
            <ActionIcon
              component="div"
              variant="subtle"
              color="red"
              onClick={(e) => {
                e.stopPropagation();
                form.removeListItem('strategies', idx);
              }}
            >
              <IconTrash size="1rem" />
            </ActionIcon>
          </Group>
          <Text size="xs" c="dimmed">
            Base Strategy: {meta.label}
          </Text>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack>
            <TextInput
              label="Test case alias"
              description="Name in the report"
              {...form.getInputProps(`strategies.${idx}.alias`)}
            />
            {hasParams && <Divider label="Parameters" labelPosition="center" my="sm" />}
            <SimpleGrid cols={2} spacing="sm">
              {hasParams ? (
                Object.entries(paramDefs).map(([k, def]) => (
                  <ParamInput
                    key={k}
                    form={form}
                    path={`strategies.${idx}.params`}
                    paramKey={k}
                    pDef={def}
                  />
                ))
              ) : (
                <Text c="dimmed" ta="center" fz="sm" w="100%" mt="md">
                  Self‑optimizing or parameter-free strategy
                </Text>
              )}
            </SimpleGrid>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    );
  });

  const renderResults = () => {
    if (jobStatus === 'idle') {
      return (
        <Center h={400}>
          <Stack align="center" spacing="md">
            <IconReportAnalytics size={60} stroke={1.5} color={theme.colors.gray[6]} />
            <Title order={3} ta="center">
              Ready to run
            </Title>
            <Text c="dimmed" ta="center">
              Configure settings then press Run Backtest
            </Text>
          </Stack>
        </Center>
      );
    }
    if (jobStatus === 'running') return <ResultsSkeleton />;
    if (jobStatus === 'failed')
      return (
        <Alert
          icon={<IconAlertCircle size="1rem" />}
          title="Job failed"
          color="red"
        >
          <Text>Error details:</Text>
          <Code block mt="sm">
            {jobError}
          </Code>
        </Alert>
      );
    return results ? <ResultsDisplay report={results} onAddPair={onAddPair} /> : null;
  };

  /* responsive spans */
  const configSpan = resultsExpanded ? { base: 12, lg: 4 } : { base: 12, lg: 5 };
  const resultsSpan = resultsExpanded ? { base: 12, lg: 8 } : { base: 12, lg: 7 };

  /* ──────────────────────────────────────────
     JSX
     ────────────────────────────────────────── */
  return (
    <>
      {/* header */}
      <Group justify="space-between" mb="md">
        <Title order={2}>Backtest Lab</Title>
        <Tooltip label="Show guide">
          <ActionIcon variant="subtle" onClick={() => setShowHelp((o) => !o)}>
            <IconInfoCircle size={20} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* collapsible help */}
      <Collapse in={showHelp} mb="md">
        <Alert
          icon={<IconInfoCircle size="1rem" />}
          variant="outline"
          color="blue"
          title="How to Use the Backtest Lab"
        >
          <List size="sm" spacing="xs">
            <List.Item>
              <b>Set Environment:</b> Define the exchange, timeframe, date range, and initial capital for your test.
            </List.Item>
            <List.Item>
              <b>Select Symbols:</b> Provide a manual list of symbols or use a saved Market Screener configuration to source them automatically.
            </List.Item>
            <List.Item>
              <b>Configure Strategies:</b> Add one or more strategies to test. You can bulk-add all compatible strategies and tweak their parameters individually.
            </List.Item>
            <List.Item>
              <b>Run & Analyze:</b> A multi-strategy, portfolio-level report will be generated. You can drill down into each individual test.
            </List.Item>
          </List>
        </Alert>
      </Collapse>

      <Grid gutter="xl">
        {/* CONFIG COLUMN */}
        <Grid.Col span={configSpan}>
          <Paper withBorder p="md" radius="md">
            <ScrollArea h="calc(90vh - 160px)">
              <form onSubmit={form.onSubmit(runBacktest)}>
                <Stack gap="sm">
                  {/* GENERAL */}
                  <Title order={4}>General settings</Title>
                  <TextInput
                    label="Run Name"
                    description="A unique name for this backtest run"
                    required
                    {...form.getInputProps('scenario_name')}
                  />
                  <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                    <Select
                      label="Exchange"
                      data={availableExchanges}
                      searchable
                      disabled={exchangesLoading}
                      placeholder={exchangesLoading ? 'Loading...' : 'Select exchange'}
                      leftSection={<IconBuildingStore size={16} />}
                      {...form.getInputProps('exchange')}
                    />
                    <NumberInput
                      label="Initial capital"
                      prefix="$ "
                      min={100}
                      step={1000}
                      thousandSeparator
                      {...form.getInputProps('initial_capital')}
                    />
                    <Select
                      label="Timeframe"
                      data={availableTimeframes}
                      {...form.getInputProps('timeframe')}
                    />
                    <DatePickerInput
                      type="range"
                      label="Date range"
                      placeholder="Pick dates"
                      {...form.getInputProps('dateRange')}
                    />
                  </SimpleGrid>

                  {/* SYMBOLS */}
                  <Divider label="Symbol Selection" mt="sm" />
                  <Select
                    data={selectionMethods}
                    {...form.getInputProps('selection_method')}
                  />
                  {form.values.selection_method === 'EXPLICIT_LIST' && (
                    <TagsInput
                      label="Symbols"
                      description="Press Enter to add"
                      leftSection={<IconList size="1rem" />}
                      {...form.getInputProps('symbols')}
                    />
                  )}
                  {form.values.selection_method === 'FROM_CONFIG' && (
                    <Select
                      label="Screener config"
                      placeholder={configsLoading ? 'Loading…' : 'Choose config'}
                      data={screenerConfigs}
                      disabled={configsLoading}
                      leftSection={<IconZoomCode size="1rem" />}
                      searchable
                      {...form.getInputProps('screener_config_name')}
                    />
                  )}

                  {/* STRATEGIES */}
                  <Divider label="Strategies" mt="sm" />
                  <Group>
                    <Select
                      style={{ flex: 1 }}
                      data={availableStrategies
                        .filter(s => !(s.is_legacy && form.values.exchange !== 'binance'))
                        .map((s) => ({
                          value: s.value,
                          label: s.label,
                        }))
                      }
                      value={selectedStrategyToAdd}
                      onChange={setSelectedStrategyToAdd}
                      searchable
                      disabled={strategiesLoading}
                      renderOption={renderSelectOption}
                    />
                    <Tooltip label="Add selected">
                      <ActionIcon
                        variant="filled"
                        color="blue"
                        size="lg"
                        onClick={handleAddStrategy}
                        disabled={!selectedStrategyToAdd}
                      >
                        <IconPlus size="1.2rem" />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Add all compatible strategies">
                      <ActionIcon
                        variant="outline"
                        color="blue"
                        size="lg"
                        onClick={handleAddAllStrategies}
                        disabled={strategiesLoading}
                      >
                        <IconPlaystationCircle size="1.2rem" />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                  {form.errors.strategies && (
                    <Text c="red" size="xs">
                      {form.errors.strategies}
                    </Text>
                  )}

                  <Accordion variant="separated" mt="sm">
                    {strategyForms}
                  </Accordion>

                  {/* RUN */}
                  <Button
                    type="submit"
                    mt="md"
                    loading={jobStatus === 'running'}
                    disabled={form.values.strategies.length === 0}
                  >
                    Run Backtest
                  </Button>
                </Stack>
              </form>
            </ScrollArea>
          </Paper>
        </Grid.Col>

        {/* RESULTS COLUMN */}
        <Grid.Col span={resultsSpan}>
          <Card withBorder radius="md" p="md" h="calc(90vh - 120px)" style={{minHeight: '85vh'}}>
            <Title order={4} mb="xs">
              Latest Run Report
            </Title>
            <ScrollArea h="100%">{renderResults()}</ScrollArea>
          </Card>
        </Grid.Col>
      </Grid>
    </>
  );
}
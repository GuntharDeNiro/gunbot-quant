// App.jsx
import { useState, useEffect, useMemo } from 'react';
import {
  AppShell,
  Group,
  Title,
  ActionIcon,
  MantineProvider,
  createTheme,
  Stack,
  Code,
  UnstyledButton,
  Text,
  Overlay,
  Paper,
  Portal,
  Select,
  SimpleGrid,
  NumberInput,
  Button,
  Divider,
  Alert,
  Center,
  Loader,
  Switch,
  Tooltip as MantineTooltip,
  ThemeIcon,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import {
  IconGauge,
  IconZoomCode,
  IconTestPipe,
  IconHexagonLetterG,
  IconReportAnalytics,
  IconFileSearch,
  IconRobot,
  IconTrophy,
  IconAlertCircle,
  IconCheck,
  IconX,
  IconPlugConnected,
  IconPlugConnectedX,
  IconInfoCircle
} from '@tabler/icons-react';

import Dashboard from './Dashboard';
import Screener from './Screener';
import Backtester from './Backtester';
import ResultsViewer from './ResultsViewer';
import ScreenerHistory from './ScreenerHistory';
import GunbotConnect from './GunbotConnect';
import DiscoveryResults from './DiscoveryResults';

const theme = createTheme({
  fontFamily: 'Inter, sans-serif',
  headings: { fontFamily: 'Inter, sans-serif' },
});

// z-index values for modal, panel and dropdown
const MODAL_Z = 10000;
const PANEL_Z = MODAL_Z + 1;
const DROPDOWN_Z = PANEL_Z + 1;

function GunbotStatus() {
    const { data: statusData, isLoading } = useQuery({
        queryKey: ['gunbotStatus'],
        queryFn: async () => {
            const res = await fetch('/api/v1/gunbot/status');
            if (!res.ok) return { connected: false };
            return res.json();
        },
        refetchInterval: 30000,
        staleTime: 25000,
        retry: false,
    });

    if (isLoading) {
        return <Loader size="xs" />;
    }

    if (!statusData?.connected) {
        return (
            <MantineTooltip label="Not connected. Go to the Gunbot Tools page to connect." withArrow>
                <Group gap="xs">
                    <ThemeIcon color="gray" size={24} radius="xl">
                        <IconPlugConnectedX size={14} />
                    </ThemeIcon>
                    <Text size="xs" c="dimmed">Disconnected</Text>
                </Group>
            </MantineTooltip>
        );
    }

    const { protocol, host, port } = statusData.config || {};

    return (
        <MantineTooltip label={`Connected to Gunbot at ${protocol}://${host}:${port}`} withArrow>
            <Group gap="xs">
                <ThemeIcon color="green" size={24} radius="xl">
                    <IconPlugConnected size={14} />
                </ThemeIcon>
                <Stack gap={0}>
                    <Text size="xs" fw={500} c="green.4">Connected</Text>
                    <Text size="xs" c="dimmed" lh={1.1}>{host}:${port}</Text>
                </Stack>
            </Group>
        </MantineTooltip>
    );
}

function SafeModal({ opened, onClose, size = 'lg', children }) {
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

const fetchStrategies = async () => {
  const r = await fetch('/api/v1/strategies');
  if (!r.ok) throw new Error('Could not load strategies');
  return r.json();
};

const fetchGunbotConfig = async () => {
  const r = await fetch('/api/v1/gunbot/config');
  if (!r.ok) {
    const data = await r.json().catch(() => ({ detail: 'Bad JSON' }));
    throw new Error(data.detail || 'Could not load Gunbot config');
  }
  return r.json();
};

const addPairToGunbot = async (body) => {
  const r = await fetch('/api/v1/gunbot/pairs/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.detail || 'Failed to add pair');
  return data;
};

function AddPairModal({ opened, onClose, pairData, strategies, stratLoading, gbConfig, gbLoading, gbError }) {
  const qc = useQueryClient();

  const form = useForm({
    initialValues: {
      exchange: '',
      strategy_name: '',
      strategy_params: {},
      buy_enabled: true,
      sell_enabled: true,
      initial_capital: 1000,
      min_volume_to_sell: 10,
      start_time: new Date(),
    },
  });

  useEffect(() => {
    // This effect should ONLY run when the modal is opened.
    // It initializes the form state and then does nothing else, preserving user input.
    if (opened && pairData && strategies && gbConfig) {
      const targetStratKey = pairData.strategy_key || '';
      const meta = strategies.find((s) => s.value === targetStratKey);

      // Build a clean parameter object from the strategy definition (source of truth)
      const cleanParams = {};
      if (meta?.params_def) {
        // Iterate over the DEFINED params, not the incoming ones
        for (const key in meta.params_def) {
          // Check if the backtest result provided a value for this specific (correct) key
          if (pairData.parameters && pairData.parameters[key] !== undefined) {
            cleanParams[key] = pairData.parameters[key];
          } else {
            // Otherwise, use the default from the metadata
            cleanParams[key] = meta.params_def[key].default;
          }
        }
      }

      form.setValues({
        exchange: pairData.exchange || gbConfig.exchanges?.[0] || '',
        strategy_name: targetStratKey,
        strategy_params: cleanParams, // Use the new, clean object
        buy_enabled: true,
        sell_enabled: true,
        initial_capital: 1000,
        min_volume_to_sell: 10,
        start_time: new Date(),
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, pairData?.symbol]); // Depend on stable values, not the object reference.

  const stratMeta = useMemo(
    () => strategies?.find((s) => s.value === form.values.strategy_name),
    [strategies, form.values.strategy_name]
  );
  
  const gunbotPair = useMemo(() => {
    // More defensive calculation to prevent "N/A"
    if (!pairData?.symbol || !pairData?.quote_asset) return pairData?.symbol || 'N/A';
    const base = pairData.symbol.replace(pairData.quote_asset, '');
    return `${pairData.quote_asset}-${base}`;
  }, [pairData]);

  const onStratChange = (v) => {
    form.setFieldValue('strategy_name', v);
    const meta = strategies.find((s) => s.value === v);
    const params = {};
    if (meta?.params_def) {
      Object.entries(meta.params_def).forEach(([k, def]) => {
        params[k] = def.default;
      });
    }
    form.setFieldValue('strategy_params', params);
  };

  const mut = useMutation({
    mutationFn: addPairToGunbot,
    onSuccess: (d) => {
      notifications.show({
        title: 'Success',
        message: d.message,
        color: 'green',
        icon: <IconCheck />,
      });
      qc.invalidateQueries({ queryKey: ['gunbotTradingPairs'] });
      onClose();
    },
    onError: (e) =>
      notifications.show({
        title: 'Error Adding Pair',
        message: e.message,
        color: 'red',
      }),
  });

  const onSubmit = (v) => {
    if (!pairData.quote_asset || !pairData.symbol || !pairData.timeframe) {
      notifications.show({
        title: 'Error',
        message: 'Essential pair data (symbol, quote, timeframe) is missing.',
        color: 'red',
      });
      return;
    }
    mut.mutate({
      exchange: v.exchange,
      standard_pair: pairData.symbol,
      quote_asset: pairData.quote_asset,
      timeframe: pairData.timeframe, // Pass timeframe
      strategy_name: v.strategy_name,
      strategy_params: v.strategy_params, // Pass fully populated params
      buy_enabled: v.buy_enabled,
      sell_enabled: v.sell_enabled,
      stop_after_sell: v.stop_after_sell,
      initial_capital: v.initial_capital,
      min_volume_to_sell: v.min_volume_to_sell,
      start_time: v.start_time.getTime(),
    });
  };

  const body = (() => {
    if (stratLoading || (opened && gbLoading))
      return (
        <Center p="xl">
          <Loader />
        </Center>
      );

    if (gbError)
      return (
        <Alert
          color="red"
          icon={<IconAlertCircle />}
          title="Could not load Gunbot config"
        >
          {gbError.message}
        </Alert>
      );

    if (!strategies?.length)
      return (
        <Alert color="red" icon={<IconAlertCircle />}>
          Strategy list empty
        </Alert>
      );

    if (!gbConfig?.exchanges?.length)
      return (
        <Alert
          color="red"
          icon={<IconAlertCircle />}
          title="Invalid Gunbot configuration"
        >
          No exchanges found
        </Alert>
      );

    return (
      <form onSubmit={form.onSubmit(onSubmit)}>
        <Stack>
          <Alert variant="light" color="blue">
            This will add the pair as <Code>{gunbotPair}</Code> in Gunbot using the <Code>{pairData?.timeframe}</Code> timeframe.
          </Alert>
          <SimpleGrid cols={2}>
            <Select
              label="Gunbot Exchange"
              data={gbConfig.exchanges}
              searchable
              withinPortal
              portalProps={{ zIndex: DROPDOWN_Z }}
              popperProps={{ strategy: 'fixed' }}
              styles={{ dropdown: { zIndex: DROPDOWN_Z } }}
              {...form.getInputProps('exchange')}
            />
            <Select
              label="Strategy"
              data={strategies
                .filter((s) => !s.is_legacy || s.value === 'Dynamic_Momentum_Optimizer')
                .map((s) => ({ value: s.value, label: s.label }))}
              searchable
              withinPortal
              portalProps={{ zIndex: DROPDOWN_Z }}
              popperProps={{ strategy: 'fixed' }}
              styles={{ dropdown: { zIndex: DROPDOWN_Z } }}
              onChange={onStratChange}
              value={form.values.strategy_name}
            />
          </SimpleGrid>
          
          {stratMeta?.description && (
            <Alert variant="outline" color="gray" title="Strategy Logic" icon={<IconInfoCircle />}>
              <Text size="sm">{stratMeta.description}</Text>
            </Alert>
          )}

          <Divider my="sm" label="General Pair Settings" labelPosition="center" />
          <SimpleGrid cols={2} spacing="sm">
             <Switch label="Buy Enabled" {...form.getInputProps('buy_enabled', { type: 'checkbox' })} />
             <Switch label="Sell Enabled" {...form.getInputProps('sell_enabled', { type: 'checkbox' })} />
          </SimpleGrid>
          <SimpleGrid cols={2}>
              <NumberInput label="Initial Capital" {...form.getInputProps('initial_capital')} />
              <NumberInput label="Min Volume to Sell" {...form.getInputProps('min_volume_to_sell')} />
          </SimpleGrid>

          {stratMeta?.params_def && Object.keys(stratMeta.params_def).length > 0 && (
            <>
              <Divider my="sm" label="Strategy Parameters" labelPosition="center" />
              <SimpleGrid cols={2}>
                {Object.entries(stratMeta.params_def).map(([key, def]) => {
                  const descriptionParts = [];
                  if (def.description) {
                    descriptionParts.push(def.description);
                  }
                  
                  const rangeParts = [];
                  if (typeof def.min === 'number') {
                    rangeParts.push(`Min: ${def.min}`);
                  }
                  if (typeof def.max === 'number') {
                    rangeParts.push(`Max: ${def.max}`);
                  }
                  
                  if (rangeParts.length > 0) {
                    descriptionParts.push(`(${rangeParts.join(', ')})`);
                  }

                  return (
                    <NumberInput
                      key={key}
                      label={def.label}
                      description={descriptionParts.join(' ')}
                      min={def.min}
                      max={def.max}
                      step={def.step || 1}
                      allowDecimal={def.type === 'float'}
                      {...form.getInputProps(`strategy_params.${key}`)}
                    />
                  );
                })}
              </SimpleGrid>
            </>
          )}

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={mut.isPending}
              disabled={!form.values.exchange || !form.values.strategy_name}
            >
              Add to Gunbot
            </Button>
          </Group>
        </Stack>
      </form>
    );
  })();

  return (
    <SafeModal opened={opened} onClose={onClose} size="lg">
      <Group justify="space-between" mb="md">
        <Title order={4}>Add {pairData?.symbol} to Gunbot</Title>
        <ActionIcon variant="subtle" onClick={onClose}>
          <IconX size={18} />
        </ActionIcon>
      </Group>
      {body}
    </SafeModal>
  );
}

const navLinks = [
  { icon: IconGauge, label: 'Dashboard', view: 'dashboard' },
  { icon: IconZoomCode, label: 'Market Screener', view: 'screener' },
  { icon: IconTestPipe, label: 'Backtest Lab', view: 'backtester' },
  { icon: IconRobot, label: 'Gunbot Tools', view: 'gunbot_connect' },
  { icon: IconReportAnalytics, label: 'Backtest History', view: 'history' },
  { icon: IconFileSearch, label: 'Screener History', view: 'screener_history' },
  { icon: IconTrophy, label: 'Discovery Results', view: 'discovery_result' },
];

function NavLink({ icon: Icon, label, active, onClick }) {
  return (
    <UnstyledButton
      onClick={onClick}
      data-active={active || undefined}
      style={(t) => ({
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: t.spacing.xs,
        borderRadius: t.radius.sm,
        color: active ? t.colors.blue[6] : t.white,
        backgroundColor: active ? t.colors.dark[5] : 'transparent',
        '&:hover': { backgroundColor: t.colors.dark[6] },
      })}
    >
      <Icon style={{ width: 22, height: 22 }} stroke={1.5} />
      <Text size="sm" fw={500} style={{ marginLeft: 12 }}>
        {label}
      </Text>
    </UnstyledButton>
  );
}

function App() {
  const [view, setView] = useState('dashboard');
  const [resultId, setResultId] = useState(null);
  const [screenerId, setScreenerId] = useState(null);
  const [discId, setDiscId] = useState(null);

  const [modalOpen, { open: openModal, close: closeModal }] = useDisclosure(false);
  const [pair, setPair] = useState(null);

  // --- Data fetching hooks ---
  const { data: statusData } = useQuery({
    queryKey: ['gunbotStatus'],
    queryFn: async () => {
        const res = await fetch('/api/v1/gunbot/status');
        if (!res.ok) return { connected: false };
        return res.json();
    },
    refetchInterval: 30000,
  });
  const isConnected = statusData?.connected === true;

  const { data: strategies, isLoading: stratLoading } = useQuery({
    queryKey: ['strategies'],
    queryFn: fetchStrategies,
  });
  
  const { data: gbConfig, isLoading: gbLoading, error: gbError } = useQuery({
    queryKey: ['gunbotConfig'],
    queryFn: fetchGunbotConfig,
    retry: false,
    enabled: isConnected,
  });

  const handleAddPair = (dataFromReport) => {
    console.log("Data received by onAddPair:", JSON.stringify(dataFromReport, null, 2));

    const strategyKey = dataFromReport.base_strategy_name;
    const meta = strategies?.find(s => s.value === strategyKey);
    
    if (meta?.is_legacy && meta.value !== 'Dynamic_Momentum_Optimizer') {
      notifications.show({
        title: 'Strategy Not Addable',
        message: `${meta.label} is a legacy strategy and cannot be added directly.`,
        color: 'yellow',
        icon: <IconAlertCircle />,
      });
      return;
    }

    const cleanPairData = {
      symbol: dataFromReport.symbol,
      strategy_key: strategyKey,
      parameters: dataFromReport.parameters || {},
      quote_asset: dataFromReport.quote_asset,
      exchange: dataFromReport.exchange,
      timeframe: dataFromReport.timeframe,
    };
    setPair(cleanPairData);
    openModal();
  };

  const mainView = (() => {
    switch (view) {
      case 'dashboard':
        return (
          <Dashboard
            navigateToResult={(id) => {
              setResultId(id);
              setView('history');
            }}
            navigateToScreenerResult={(id) => {
              setScreenerId(id);
              setView('screener_history');
            }}
            navigateToView={setView}
          />
        );
      case 'screener':
        return <Screener onAddPair={handleAddPair} />;
      case 'backtester':
        return <Backtester onAddPair={handleAddPair} />;
      case 'history':
        return <ResultsViewer initialJobId={resultId} onAddPair={handleAddPair} />;
      case 'screener_history':
        return <ScreenerHistory initialJobId={screenerId} onAddPair={handleAddPair} />;
      case 'gunbot_connect':
        return (
          <GunbotConnect
            navigateToResult={(id) => {
              setResultId(id);
              setView('history');
            }}
            navigateToDiscoveryResult={(id) => {
              setDiscId(id);
              setView('discovery_result');
            }}
          />
        );
      case 'discovery_result':
        return (
          <DiscoveryResults
            initialJobId={discId}
            navigateToGunbotConnect={() => setView('gunbot_connect')}
            onAddPair={handleAddPair}
          />
        );
      default:
        return null;
    }
  })();

  const links = navLinks.map((link) => (
    <NavLink
      {...link}
      key={link.label}
      active={view === link.view}
      onClick={() => {
        if (link.view === 'discovery_result') setDiscId(null);
        setView(link.view);
      }}
    />
  ));

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <AddPairModal
        opened={modalOpen}
        onClose={closeModal}
        pairData={pair}
        strategies={strategies}
        stratLoading={stratLoading}
        gbConfig={gbConfig}
        gbLoading={gbLoading}
        gbError={gbError}
      />
      <AppShell
        navbar={{ width: 280, breakpoint: 'sm', collapsed: { mobile: false } }}
        padding="md"
        layout="alt"
      >
        <AppShell.Navbar p="md">
          <Stack justify="space-between" style={{ height: '100%' }}>
            <Stack>
              <Group>
                <IconHexagonLetterG type="mark" size={30} />
                <Title order={4}>Gunbot Quant</Title>
                <Code fw={700}>v1.1</Code>
              </Group>
              <Stack gap="sm" mt="xl">
                {links}
              </Stack>
            </Stack>
            <Paper withBorder p="xs" radius="md" bg="dark.8">
              <GunbotStatus />
            </Paper>
          </Stack>
        </AppShell.Navbar>
        <AppShell.Main style={{ minWidth: '100vw' }}>{mainView}</AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
}

export default App;
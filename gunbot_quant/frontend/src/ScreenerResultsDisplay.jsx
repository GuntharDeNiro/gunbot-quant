/* eslint react/prop-types: 0 */
import { memo, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Divider,
  Grid,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip as MantineTooltip,
  useMantineTheme,
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import {
  IconInfoCircle,
  IconArrowBackUp,
  IconPlus,
  IconSearch,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';

/* ---------------------------------------------------------------------------
   Stat Tile & Group Components
--------------------------------------------------------------------------- */
const StatTile = memo(({ label, value, color, suffix = '', size = 'sm', tooltip }) => {
  const content = (
      <Paper
        withBorder
        p="xs"
        radius="md"
        style={{ background: 'transparent', borderColor: '#2a2a2a' }}
      >
        <Text size="xs" c="dimmed" truncate>
          {label}
        </Text>
        <Text size={size} c={color} fw={600}>
          {typeof value === 'number' && !Number.isNaN(value)
            ? value.toFixed(2)
            : (value === 'N/A' ? 'N/A' : (value ?? '--'))}
          {value !== 'N/A' && value !== '--' && suffix}
        </Text>
      </Paper>
  );

  if (tooltip) {
      return <MantineTooltip label={tooltip} withArrow withinPortal>{content}</MantineTooltip>;
  }
  return content;
});
StatTile.displayName = 'StatTile';

const StatGroup = ({ title, children }) => (
    <Paper withBorder p="md" radius="md" bg="dark.7">
        <Title order={5} mb="md">{title}</Title>
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
            {children}
        </SimpleGrid>
    </Paper>
);

// Helper to format large numbers
const formatNumber = (num, decimals = 2) => {
    if (typeof num !== 'number' || Number.isNaN(num)) return 'N/A';

    const format = (value) => {
        const fixed = value.toFixed(decimals);
        return fixed.endsWith(`.${'0'.repeat(decimals)}`) ? 
            parseInt(fixed, 10).toString() : 
            fixed;
    };

    if (num >= 1e9) return `${format(num / 1e9)}B`;
    if (num >= 1e6) return `${format(num / 1e6)}M`;
    if (num >= 1e3) return `${format(num / 1e3)}k`;
    
    return format(num);
};

const fetchGunbotStatus = async () => {
    const res = await fetch('/api/v1/gunbot/status');
    if (!res.ok) throw new Error('Network response was not ok');
    return res.json();
};

/* ---------------------------------------------------------------------------
   Main Component
--------------------------------------------------------------------------- */
export default function ScreenerResultsDisplay({ report, onAddPair }) {
  const theme = useMantineTheme();
  const [selectedSymbolId, setSelectedSymbolId] = useState(null);
  const [sortStatus, setSortStatus] = useState({
    columnAccessor: report?.rank_metric || 'symbol',
    direction: 'desc',
  });

  const { data: gunbotStatus } = useQuery({ queryKey: ['gunbotStatus'], queryFn: fetchGunbotStatus });
  const isGunbotConnected = gunbotStatus?.connected === true;

  if (!report || !report.analysis_df_json) {
    return (
      <Alert icon={<IconInfoCircle />} title="Report Empty" color="blue">
        The selected screener run does not contain valid data. This can happen if there was an issue fetching data or if the report file is corrupted.
      </Alert>
    );
  }

  if (report.symbols.length === 0) {
    return (
      <Center h={400}>
        <Stack align="center">
          <IconSearch size={46} color={theme.colors.gray[6]} />
          <Title order={3}>No Symbols Found</Title>
          <Text c="dimmed" size="sm" ta="center">
            The screener ran successfully but did not find any symbols that matched your criteria.
            <br />
            Try using broader filters or a different market.
          </Text>
        </Stack>
      </Center>
    );
  }

  const { activeData, viewName, isOverview } = useMemo(() => {
    const records = report.analysis_df_json;
    if (!selectedSymbolId) {
      return {
        activeData: {
            'Market': report.exchange === 'yfinance' ? 'US Stocks/ETFs' : `${report.exchange.toUpperCase()}/${report.quote_asset}`,
            'Timeframe': report.timeframe,
            'Ranked By': report.rank_metric.replace(/_/g, ' '),
            'Symbols Found': records.length,
        },
        viewName: 'Screener Run Overview',
        isOverview: true,
      };
    }

    const symbolData = records.find((r) => r.symbol === selectedSymbolId);
    return {
      activeData: symbolData || null,
      viewName: `Details for ${selectedSymbolId}`,
      isOverview: false,
    };
  }, [report, selectedSymbolId]);


  const recordsForTable = useMemo(() => {
    const data = [...report.analysis_df_json];
    const { columnAccessor, direction } = sortStatus;
    data.sort((a, b) => {
      const valA = a[columnAccessor] ?? -Infinity;
      const valB = b[columnAccessor] ?? -Infinity;
      if (typeof valA === 'string') return direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      if (valA > valB) return direction === 'asc' ? 1 : -1;
      if (valA < valB) return direction === 'asc' ? -1 : 1;
      return 0;
    });
    return data;
  }, [report.analysis_df_json, sortStatus]);

  const renderNumeric = (val, color = 'gray', suffix = '') => (
    <Text c={color} size="sm" ta="right" fw={500}>
        {typeof val === 'number' ? `${val.toFixed(2)}${suffix}` : '--'}
    </Text>
  );

  const getMetricColor = (metric, value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return theme.colors.gray[5];
    if (metric.includes('roc_')) return value > 0 ? theme.colors.teal[4] : theme.colors.red[4];
    if (metric.includes('price_vs_')) return value > 0 ? theme.colors.teal[4] : theme.colors.red[4];
    if (metric.includes('sma50_vs_sma200')) return value > 0 ? theme.colors.green[5] : theme.colors.red[5];
    if (metric.includes('rsi_')) return value > 70 ? theme.colors.orange[4] : value < 30 ? theme.colors.cyan[4] : theme.colors.gray[5];
    if (metric.includes('stochrsi_')) return value > 80 ? theme.colors.orange[4] : value < 20 ? theme.colors.cyan[4] : theme.colors.gray[5];
    if (metric.includes('adx_')) return value > 25 ? theme.colors.yellow[6] : theme.colors.gray[5];
    return theme.colors.blue[4];
  };

  return (
    <Stack gap="xl">
      <Card withBorder radius="md" p="lg" bg="dark.6">
        <Group justify="space-between" align="flex-start">
            <Stack gap={0}>
                <Title order={3}>{viewName}</Title>
                {!isOverview && <Text c="dimmed" size="sm" tt="capitalize">All metrics calculated on the {report.timeframe} timeframe</Text>}
            </Stack>
          {!isOverview && (
            <Button
              size="xs"
              variant="light"
              leftSection={<IconArrowBackUp size={14} />}
              onClick={() => setSelectedSymbolId(null)}
            >
              Back to Overview
            </Button>
          )}
        </Group>
        <Divider my="md" />

        {isOverview && (
             <Center p="xl">
                <SimpleGrid cols={{base: 2, sm: 4}} spacing="xl">
                    <StatTile label="Market" value={activeData['Market']} color={theme.colors.gray[4]} size="md" />
                    <StatTile label="Timeframe" value={activeData['Timeframe']} color={theme.colors.gray[4]} size="md" />
                    <StatTile label="Ranked By" value={activeData['Ranked By']} color={theme.colors.gray[4]} size="md" tt="capitalize" />
                    <StatTile label="Symbols Found" value={activeData['Symbols Found']} color={theme.colors.gray[4]} size="md" />
                </SimpleGrid>
             </Center>
        )}
        
        {!isOverview && activeData && (
          <Stack gap="lg">
            <StatGroup title="Momentum & Trend">
                <StatTile label="ROC 30p" value={activeData.roc_30p} color={getMetricColor('roc_', activeData.roc_30p)} suffix="%" />
                <StatTile label="ROC 90p" value={activeData.roc_90p} color={getMetricColor('roc_', activeData.roc_90p)} suffix="%" />
                <StatTile label="Price vs 50 SMA" value={activeData.price_vs_sma50} color={getMetricColor('price_vs_', activeData.price_vs_sma50)} suffix="%" />
                <StatTile label="50 vs 200 SMA" value={activeData.sma50_vs_sma200} color={getMetricColor('sma50_vs_sma200', activeData.sma50_vs_sma200)} suffix="%" />
                <StatTile label="ADX 14p" value={activeData.adx_14p} color={getMetricColor('adx_', activeData.adx_14p)} />
                <StatTile label="Dist from Recent High" value={activeData.dist_from_ath_lookback_pct} color={theme.colors.red[4]} suffix="%" tooltip="From recent high in loaded data" />
            </StatGroup>
            
             <StatGroup title="Volume & Volatility">
                <StatTile label="ATR 14p %" value={activeData.atr_pct_14p} color={getMetricColor('atr_', activeData.atr_pct_14p)} suffix="%" />
                <StatTile label="30d Avg Volume" value={formatNumber(activeData.avg_vol_30d_quote, 2)} color={theme.colors.blue[4]} tooltip="In quote asset (or shares for stocks)" />
                <StatTile label="Relative Volume" value={activeData.rel_vol_10d_quote || activeData.rel_vol_10d} color={(activeData.rel_vol_10d_quote || activeData.rel_vol_10d) > 1 ? theme.colors.yellow[5] : theme.colors.gray[5]} tooltip="Latest Day vs 10d Avg"/>
            </StatGroup>

             <StatGroup title="Oscillators">
                <StatTile label="RSI 14p" value={activeData.rsi_14p} color={getMetricColor('rsi_', activeData.rsi_14p)} />
                <StatTile label="StochRSI K" value={activeData.stochrsi_k_14_3_3} color={getMetricColor('stochrsi_', activeData.stochrsi_k_14_3_3)} />
                <StatTile label="StochRSI D" value={activeData.stochrsi_d_14_3_3} color={getMetricColor('stochrsi_', activeData.stochrsi_d_14_3_3)} />
            </StatGroup>

            <StatGroup title="Tradability Heuristics">
                <StatTile label="Volatility Consistency" value={activeData.volatility_consistency} color={theme.colors.grape[4]} tooltip="StdDev of daily ATR % over 90 days. Lower is better." />
                <StatTile label="Max Daily Spike" value={activeData.max_daily_spike_pct} color={theme.colors.orange[5]} suffix="%" tooltip="Largest single-day price range over 90 days." />
                <StatTile label="Volume Concentration" value={activeData.volume_concentration_pct} color={theme.colors.pink[5]} suffix="%" tooltip="Percentage of 90-day volume that occurred on the top 3 volume days." />
            </StatGroup>
          </Stack>
        )}

      </Card>
      
      <Card withBorder radius="md" p="lg" bg="dark.6">
        <Title order={4} mb="md">Filtered Symbols</Title>
        <DataTable
            withTableBorder
            borderRadius="sm"
            striped
            highlightOnHover
            sortStatus={sortStatus}
            onSortStatusChange={setSortStatus}
            records={recordsForTable}
            idAccessor="symbol"
            rowClassName={({ symbol }) => symbol === selectedSymbolId ? 'mantine-datatable-row-highlight' : ''}
            onRowClick={({ record }) => setSelectedSymbolId(record.symbol === selectedSymbolId ? null : record.symbol)}
            noRecordsText="Screener did not find any symbols matching your criteria."
            columns={[
              { accessor: 'symbol', title: 'Symbol', width: 120, sortable: true, frozen: true },
              { accessor: report.rank_metric, title: `Rank: ${report.rank_metric.replace(/_/g, ' ')}`, width: 150, textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r[report.rank_metric], theme.colors.yellow[6]), tt: 'capitalize' },
              { accessor: 'roc_30p', title: 'ROC 30p %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.roc_30p, getMetricColor('roc_', r.roc_30p), '%') },
              { accessor: 'atr_pct_14p', title: 'ATR 14p %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.atr_pct_14p, getMetricColor('atr_', r.atr_pct_14p), '%') },
              { accessor: 'rsi_14p', title: 'RSI 14p', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.rsi_14p, getMetricColor('rsi_', r.rsi_14p)) },
              { accessor: 'adx_14p', title: 'ADX 14p', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.adx_14p, getMetricColor('adx_', r.adx_14p)) },
              { accessor: 'avg_vol_30d_quote', title: 'Vol 30d', textAlignment: 'right', sortable: true, render: (r) => <Text size="sm" ta="right">{formatNumber(r.avg_vol_30d_quote)}</Text> },
              {
                accessor: 'actions', title: 'Actions', textAlignment: 'right', width: 100,
                render: (screenerResult) => {
                  if (report.exchange === 'yfinance') return null;
                  const tooltipLabel = isGunbotConnected ? `Deploy ${screenerResult.symbol} to Gunbot` : "Connect to Gunbot to add pairs";
                  return (
                    <MantineTooltip label={tooltipLabel} withArrow>
                      <ActionIcon disabled={!isGunbotConnected} onClick={(e) => { e.stopPropagation(); if (onAddPair) onAddPair({ ...screenerResult, quote_asset: report.quote_asset, exchange: report.exchange, timeframe: report.timeframe }); }}>
                        <IconPlus size={16} />
                      </ActionIcon>
                    </MantineTooltip>
                  );
                },
              },
            ]}
        />
      </Card>
    </Stack>
  );
}
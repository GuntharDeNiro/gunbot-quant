import { Card, Grid, SimpleGrid, Text, Title, useMantineTheme, Table, Paper, ActionIcon, Tooltip as MantineTooltip, Alert, Stack, Loader, Center, List, ThemeIcon, Button, Group } from '@mantine/core';
import { IconTrendingUp, IconReceipt2, IconZoomCode, IconTestPipe, IconEye, IconInfoCircle, IconArrowRight, IconTrophy, IconFileAnalytics, IconHistory, IconBox, IconListDetails, IconRobot } from '@tabler/icons-react';
import { useState, useEffect } from 'react';

function StatCard({ title, description, icon: Icon, onClick, theme }) {
    return (
        <Paper
            withBorder
            p="md"
            radius="md"
            style={{
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                '&:hover': {
                    transform: 'translateY(-2px)',
                    boxShadow: theme.shadows.md
                }
            }}
            onClick={onClick}
        >
            <Group justify="space-between" gap="sm">
                <div style={{ flex: 1 }}>
                    <Text size="md" fw={600} mb={4}>{title}</Text>
                    <Text size="sm" c="dimmed">{description}</Text>
                </div>
                <ThemeIcon variant="light" size={40} radius="md">
                    <Icon size={20} />
                </ThemeIcon>
            </Group>
        </Paper>
    );
}

const renderNumeric = (value, colorPositive = 'teal', colorNegative = 'red', suffix = '') => {
    const num = value ?? 0;
    return <Text c={num >= 0 ? colorPositive : colorNegative} size="sm" fw={500}>{(num).toFixed(2)}{suffix}</Text>;
};

export default function Dashboard({ navigateToResult, navigateToScreenerResult, navigateToView }) {
    const theme = useMantineTheme();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [data, setData] = useState({
        topPerformers: [],
        recentBacktests: [],
        recentScreeners: [],
        screenerConfigs: [],
    });
    const [showWelcome, setShowWelcome] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            setError(null);
            try {
                const [backtestRes, screenerRes, configsRes] = await Promise.all([
                    fetch('/api/v1/backtest/results'),
                    fetch('/api/v1/screen/results'),
                    fetch('/api/v1/screen/configs'),
                ]);

                if (!backtestRes.ok || !screenerRes.ok || !configsRes.ok) {
                    throw new Error('Failed to fetch initial dashboard data.');
                }

                const backtestJobs = await backtestRes.json();
                const screenerJobs = await screenerRes.json();
                const screenerConfigs = await configsRes.json();

                const recentReportsToFetch = backtestJobs.slice(0, 5);

                let allStats = [];
                if (recentReportsToFetch.length > 0) {
                    // Fetch reports one by one to avoid overwhelming server
                    const reports = [];
                    for (const id of recentReportsToFetch) {
                        const res = await fetch(`/api/v1/backtest/results/${id}`);
                        if (res.ok) {
                            reports.push(await res.json());
                        }
                    }

                    allStats = reports.flatMap(report =>
                        (report.individual_tests || []).map(test => ({ ...test.stats, Strategy: test.strategy_name, Symbol: test.symbol, jobId: report.scenario_name }))
                    );
                }

                const topPerformers = allStats
                    .sort((a, b) => (b['Sharpe Ratio (ann.)'] ?? 0) - (a['Sharpe Ratio (ann.)'] ?? 0))
                    .slice(0, 5);

                setData({
                    topPerformers,
                    recentBacktests: backtestJobs.slice(0, 5),
                    recentScreeners: screenerJobs.slice(0, 5),
                    screenerConfigs: screenerConfigs.slice(0, 5),
                });

            } catch (err) {
                setError(err.message);
                console.error("Dashboard fetch error:", err);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    const topPerformerRows = data.topPerformers.map((stat, index) => (
        <Table.Tr key={`${stat.jobId}-${stat.Strategy}-${stat.Symbol}-${index}`} style={{ cursor: 'pointer' }} onClick={() => navigateToResult(stat.jobId)}>
            <Table.Td><Text fw={500} size="sm">{stat.Strategy}</Text></Table.Td>
            <Table.Td><Text c="dimmed" size="sm">{stat.Symbol}</Text></Table.Td>
            <Table.Td>{renderNumeric(stat['Sharpe Ratio (ann.)'])}</Table.Td>
            <Table.Td>{renderNumeric(stat['Total Return %'], 'teal', 'red', '%')}</Table.Td>
            <Table.Td><Text c="dimmed" size="sm">{stat['Total Trades']}</Text></Table.Td>
            <Table.Td>
                <MantineTooltip label="View Full Report">
                    <ActionIcon variant="subtle" size="sm" onClick={(e) => { e.stopPropagation(); navigateToResult(stat.jobId); }}>
                        <IconEye size={14} />
                    </ActionIcon>
                </MantineTooltip>
            </Table.Td>
        </Table.Tr>
    ));

    const renderList = (items, onNavigate, emptyText) => {
        if (items.length === 0) {
            return <Text c="dimmed" size="sm" ta="center" mt="md" py="lg">{emptyText}</Text>;
        }
        return (
            <List spacing="sm" size="sm">
                {items.map(item => (
                    <List.Item
                        key={item}
                        icon={<ThemeIcon size={18} radius="xl" variant="light"><IconArrowRight size={12} /></ThemeIcon>}
                        onClick={() => onNavigate(item)}
                        style={{
                            cursor: 'pointer',
                            padding: '4px 8px',
                            borderRadius: theme.radius.sm,
                            transition: 'background-color 0.2s ease',
                            '&:hover': {
                                backgroundColor: theme.colors.dark[8]
                            }
                        }}
                    >
                        <Text size="sm" fw={500}>{item}</Text>
                    </List.Item>
                ))}
            </List>
        )
    };

    if (loading) {
        return <Center><Loader /></Center>;
    }

    if (error) {
        return <Alert color="red" title="Error Loading Dashboard" icon={<IconInfoCircle />}>{error}</Alert>;
    }

    return (
        <Stack gap="md">
            <Group justify="space-between" align="center" mb="lg">
                <div>
                    <Title order={2} mb={2}>Dashboard</Title>
                    <Text size="sm" c="dimmed">Welcome to your quantitative analysis hub</Text>
                </div>
                <Button variant="light" size="sm" onClick={() => setShowWelcome(true)}>
                    Show Guide
                </Button>
            </Group>

            {showWelcome && (
                <Alert
                    icon={<IconInfoCircle size="1rem" />}
                    title="Welcome to Gunbot Quant!"
                    color="blue"
                    variant="light"
                    withCloseButton
                    onClose={() => setShowWelcome(false)}
                >
                    <Text>
                        This is your workspace for quantitative trading analysis. Here’s what you can do:
                    </Text>
                    <List spacing="xs" mt="sm" size="sm">
                        <List.Item icon={<ThemeIcon color="cyan" size={20} radius="xl"><IconZoomCode size={12} /></ThemeIcon>}>
                            <b>Find Opportunities:</b> Use the <strong>Market Screener</strong> to filter crypto or stock markets for assets that match your specific technical criteria.
                        </List.Item>
                        <List.Item icon={<ThemeIcon color="lime" size={20} radius="xl"><IconTestPipe size={12} /></ThemeIcon>}>
                            <b>Validate Strategies:</b> Take your screened assets (or any list of symbols) into the <strong>Backtest Lab</strong>. Test them against a library of pre-built, configurable strategies to see how they would have performed.
                        </List.Item>
                        <List.Item icon={<ThemeIcon color="grape" size={20} radius="xl"><IconRobot size={12} /></ThemeIcon>}>
                            <b>Deploy & Analyze:</b> Any strategy you backtest can be added to a connected <a href="https://www.gunbot.com" target="_blank" rel="noopener" style={{ color: theme.colors.blue[4] }}>Gunbot</a> instance with one click, using the exact parameters you tested. Use the <strong>Gunbot Tools</strong> to analyze live performance and discover even better pairs.
                        </List.Item>
                    </List>
                    <Text mt="md" size="sm">
                        Use the navigation menu on the left to get started.
                    </Text>
                </Alert>
            )}

            <Paper withBorder p="md" radius="md" shadow="xs">
                <Group justify="space-between" mb="sm">
                    <Title order={4}>Quick Start</Title>
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    <StatCard title="Market Screener" description="Find promising assets by applying technical filters." icon={IconZoomCode} onClick={() => navigateToView('screener')} theme={theme} />
                    <StatCard title="Backtest Lab" description="Test your strategies against historical market data." icon={IconTestPipe} onClick={() => navigateToView('backtester')} theme={theme} />
                </SimpleGrid>
            </Paper>

            <Paper withBorder p="md" radius="md" shadow="xs">
                <Group justify="space-between" mb="sm">
                    <div>
                        <Title order={4}>Top Performing Strategies</Title>
                        <Text size="xs" c="dimmed">
                            Based on Sharpe Ratio from the 5 most recent backtest runs. Click a row to view the full report.
                        </Text>
                    </div>
                    <IconTrophy size={20} color={theme.colors.yellow[6]} />
                </Group>
                <Table.ScrollContainer minWidth={600}>
                    <Table verticalSpacing="sm" striped highlightOnHover withTableBorder>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Strategy</Table.Th>
                                <Table.Th>Symbol</Table.Th>
                                <Table.Th>Sharpe Ratio</Table.Th>
                                <Table.Th>Return %</Table.Th>
                                <Table.Th>Trades</Table.Th>
                                <Table.Th>Actions</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>{topPerformerRows.length > 0 ? topPerformerRows : <Table.Tr><Table.Td colSpan={6} align="center"><Text c="dimmed">No backtest data found.</Text></Table.Td></Table.Tr>}</Table.Tbody>
                    </Table>
                </Table.ScrollContainer>
            </Paper>

            <Grid>
                <Grid.Col span={{ base: 12, md: 4 }}>
                    <Paper withBorder p="md" radius="md" h="100%" shadow="xs">
                        <Group justify="space-between" mb="sm">
                            <Title order={5}>Recent Backtests</Title>
                            <IconHistory size={18} color={theme.colors.gray[5]} />
                        </Group>
                        {renderList(data.recentBacktests, navigateToResult, "No recent backtests found.")}
                    </Paper>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                    <Paper withBorder p="md" radius="md" h="100%" shadow="xs">
                        <Group justify="space-between" mb="sm">
                            <Title order={5}>Recent Screeners</Title>
                            <IconFileAnalytics size={18} color={theme.colors.gray[5]} />
                        </Group>
                        {renderList(data.recentScreeners, navigateToScreenerResult, "No recent screeners found.")}
                    </Paper>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                    <Paper withBorder p="md" radius="md" h="100%" shadow="xs">
                        <Group justify="space-between" mb="sm">
                            <Title order={5}>Saved Screener Configs</Title>
                            <IconListDetails size={18} color={theme.colors.gray[5]} />
                        </Group>
                        {renderList(data.screenerConfigs, (configName) => navigateToView('screener'), "No saved configs found.")}
                    </Paper>
                </Grid.Col>
            </Grid>
        </Stack>
    );
}
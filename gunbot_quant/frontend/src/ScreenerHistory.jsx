import { useState, useEffect } from 'react';
import {
  Select, Title, Paper, Alert, Center, Text, Grid, Stack, useMantineTheme, Group
} from '@mantine/core';
import { IconFileSearch, IconAlertCircle } from '@tabler/icons-react';
import ScreenerResultsDisplay from './ScreenerResultsDisplay';
import ScreenerResultsSkeleton from './ScreenerResultsSkeleton';

export default function ScreenerHistory({ initialJobId, onAddPair }) {
  const theme = useMantineTheme();
  const [jobList, setJobList] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState(initialJobId || null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchJobList = async () => {
      setLoadingList(true);
      try {
        const response = await fetch('/api/v1/screen/results');
        if (!response.ok) throw new Error('Failed to fetch screener result list');
        const data = await response.json();
        setJobList(data);
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
        setReport(null); // Clear previous report
        setError(null);
        try {
          const response = await fetch(`/api/v1/screen/results/${selectedJobId}`);
          if (!response.ok) throw new Error(`Failed to fetch report for ${selectedJobId}`);
          const data = await response.json();
          setReport(data);
        } catch (err)
 {
          setError(err.message);
        } finally {
          setLoadingReport(false);
        }
      };
      fetchReport();
    }
  }, [selectedJobId]);

  const renderContent = () => {
    if (loadingReport) {
        return <ScreenerResultsSkeleton />;
    }
    
    if (error) {
      return <Alert title="Error" color="red" icon={<IconAlertCircle />}>{error}</Alert>;
    }
    
    if (!selectedJobId) {
      return (
        <Center h={400}>
          <Stack align="center" spacing="md">
            <IconFileSearch size={60} stroke={1.5} color={theme.colors.gray[6]} />
            <Title order={3} ta="center">Select a Screener Report</Title>
            <Text c="dimmed" ta="center">Please choose a run from the dropdown menu above to view its results.</Text>
          </Stack>
        </Center>
      );
    }
    
    if (report) {
      return <ScreenerResultsDisplay report={report} onAddPair={onAddPair} />;
    }

    return null;
  };

  return (
    <>
      <Title order={2} mb="md">Screener History</Title>
      <Text c="dimmed" mb="xl">Browse and review results from all previously completed screener runs.</Text>
      
      <Grid>
        <Grid.Col span={12}>
          <Paper withBorder p="md" radius="md">
            <Group>
                <Select
                    label="Select a Saved Screener Run"
                    placeholder={loadingList ? "Loading results..." : "Choose a run"}
                    icon={<IconFileSearch size="1rem" />}
                    data={jobList}
                    value={selectedJobId}
                    onChange={setSelectedJobId}
                    disabled={loadingList}
                    searchable
                    style={{ flex: 1 }}
                />
            </Group>
          </Paper>
        </Grid.Col>
        <Grid.Col span={12}>
          <Paper withBorder p="xl" radius="md" miw="100%" mih={600}>
            {renderContent()}
          </Paper>
        </Grid.Col>
      </Grid>
    </>
  );
}
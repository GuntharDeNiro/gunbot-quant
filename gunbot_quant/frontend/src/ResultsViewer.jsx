import { useState, useEffect } from 'react';
import { Select, Title, Paper, Alert, Center, Text, Grid, Stack as CmpStack, useMantineTheme, Group } from '@mantine/core';
import { IconAlertCircle, IconReportAnalytics } from '@tabler/icons-react';
import ResultsDisplay from './ResultsDisplay';
import ResultsSkeleton from './ResultsSkeleton';

export default function ResultsViewer({ initialJobId, onAddPair }) {
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
        const response = await fetch('/api/v1/backtest/results');
        if (!response.ok) throw new Error('Failed to fetch result list');
        const data = await response.json();
        setJobList(data); // API now returns sorted list
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
          const data = await response.json();
          setReport(data);
        } catch (err) {
          setError(err.message);
        } finally {
          setLoadingReport(false);
        }
      };
      fetchReport();
    }
  }, [selectedJobId]);

  return (
    <>
      <Title order={2} mb="md">Backtest History</Title>
       <Text c="dimmed" mb="xl">Browse and review detailed reports from all previously completed backtest runs.</Text>
      
      <Grid>
        <Grid.Col span={12}>
           <Paper withBorder p="md" radius="md">
              <Group>
                <Select
                    label="Select a Saved Backtest Report"
                    placeholder={loadingList ? "Loading results..." : "Choose a run"}
                    icon={<IconReportAnalytics size="1rem" />}
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
              {loadingReport && <ResultsSkeleton />}
              {error && <Alert title="Error" color="red" icon={<IconAlertCircle />}>{error}</Alert>}
              
              {!selectedJobId && !loadingReport && !error && (
                  <Center h={400}>
                      <CmpStack align="center" spacing="md">
                          <IconReportAnalytics size={60} stroke={1.5} color={theme.colors.gray[6]} />
                          <Title order={3} ta="center">Select a Report</Title>
                          <Text c="dimmed" ta="center">Please choose a backtest run from the dropdown menu above to view its detailed results.</Text>
                      </CmpStack>
                  </Center>
              )}

              {report && !loadingReport && <ResultsDisplay report={report} onAddPair={onAddPair} />}
          </Paper>
        </Grid.Col>
      </Grid>
    </>
  );
}
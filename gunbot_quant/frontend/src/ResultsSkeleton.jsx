import { Skeleton, Paper, Stack, Grid } from '@mantine/core';

export default function ResultsSkeleton() {
  return (
    <Stack>
      {/* Top Card Skeleton */}
      <Paper withBorder p="lg" radius="md">
        <Grid>
          {/* Chart Area */}
          <Grid.Col span={{ base: 12, md: 8, lg: 9 }}>
            <Skeleton height={350} radius="sm" />
          </Grid.Col>
          {/* Stats Panel */}
          <Grid.Col span={{ base: 12, md: 4, lg: 3 }}>
            <Stack>
              <Skeleton height={60} radius="sm" />
              <Skeleton height={60} radius="sm" />
              <Skeleton height={40} radius="sm" mt="md" />
              <Skeleton height={80} radius="sm" />
            </Stack>
          </Grid.Col>
        </Grid>
      </Paper>

      {/* Table Skeleton */}
      <Stack mt="xl">
        <Skeleton height={20} width="30%" radius="sm" />
        <Skeleton height={380} radius="sm" />
      </Stack>
    </Stack>
  );
}
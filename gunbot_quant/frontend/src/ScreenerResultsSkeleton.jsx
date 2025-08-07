import { Skeleton, Paper, Stack, Grid, SimpleGrid } from '@mantine/core';

export default function ScreenerResultsSkeleton() {
  return (
    <Stack gap="xl">
      {/* Top Card Skeleton */}
      <Paper withBorder p="lg" radius="md" bg="dark.6">
        <Skeleton height={20} width="40%" radius="sm" mb="md" />
        <Grid>
          {/* Main Stats Panel */}
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <SimpleGrid cols={2} spacing="sm">
              <Skeleton height={60} radius="sm" />
              <Skeleton height={60} radius="sm" />
              <Skeleton height={60} radius="sm" />
              <Skeleton height={60} radius="sm" />
            </SimpleGrid>
            <Skeleton height={150} radius="sm" mt="xl" />
          </Grid.Col>
          {/* Side Info */}
          <Grid.Col span={{ base: 12, lg: 4 }}>
             <Stack>
                <Skeleton height={20} radius="sm" />
                <Skeleton height={80} radius="sm" />
             </Stack>
          </Grid.Col>
        </Grid>
      </Paper>

      {/* Table Skeleton */}
      <Paper withBorder p="lg" radius="md" bg="dark.6">
        <Skeleton height={20} width="30%" radius="sm" mb="md" />
        <Skeleton height={380} radius="sm" />
      </Paper>
    </Stack>
  );
}
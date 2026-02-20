import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

type CardProps = {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  children: React.ReactNode;
};

function Card({ title, icon, children }: CardProps) {
  return (
    <View className="bg-white rounded-2xl p-5 mb-4 shadow-sm border border-gray-100">
      <View className="flex-row items-center mb-4">
        <View className="w-8 h-8 rounded-lg bg-blue-50 items-center justify-center mr-3">
          <Ionicons name={icon} size={18} color="#2563eb" />
        </View>
        <Text className="text-base font-semibold text-gray-800">{title}</Text>
      </View>
      {children}
    </View>
  );
}

type MetricRowProps = { label: string; value: string; accent?: string };

function MetricRow({ label, value, accent }: MetricRowProps) {
  return (
    <View className="flex-row items-center justify-between py-2 border-b border-gray-50 last:border-0">
      <Text className="text-sm text-gray-600">{label}</Text>
      <Text className={`text-sm font-medium ${accent ?? 'text-gray-400'}`}>{value}</Text>
    </View>
  );
}

const ZONE_COLORS = ['text-blue-400', 'text-green-500', 'text-yellow-500', 'text-orange-500', 'text-red-500'];

export default function KeyMetricsScreen() {
  return (
    <ScrollView className="flex-1 bg-gray-50">
      <View className="px-5 pt-6 pb-10">
        {/* HR Zones */}
        <Card title="HR Zones" icon="heart-outline">
          {[1, 2, 3, 4, 5].map((zone) => (
            <MetricRow
              key={zone}
              label={`Zone ${zone}`}
              value="— – — bpm"
              accent={ZONE_COLORS[zone - 1]}
            />
          ))}
          <Text className="text-xs text-gray-400 mt-3">
            Connect a heart rate monitor or enter your max HR to calculate zones.
          </Text>
        </Card>

        {/* Lactate Threshold */}
        <Card title="Lactate Threshold" icon="pulse-outline">
          <MetricRow label="Threshold Heart Rate" value="— bpm" />
          <MetricRow label="Threshold Pace" value="—:—/mi" />
          <Text className="text-xs text-gray-400 mt-3">
            Estimated from recent race performances or workout data.
          </Text>
        </Card>

        {/* vDot Score */}
        <Card title="vDot Score" icon="speedometer-outline">
          <View className="items-center py-4">
            <Text className="text-5xl font-bold text-blue-600">—</Text>
            <Text className="text-sm text-gray-400 mt-2">No data yet</Text>
          </View>
          <Text className="text-xs text-gray-400 text-center">
            Log a race or time trial to calculate your vDot.
          </Text>
        </Card>

        {/* Estimated Race Performances */}
        <Card title="Estimated Race Performances" icon="trophy-outline">
          <MetricRow label="5K" value="—:— (—:—/mi)" />
          <MetricRow label="10K" value="—:— (—:—/mi)" />
          <MetricRow label="Half Marathon" value="—:—:— (—:—/mi)" />
          <MetricRow label="Marathon" value="—:—:— (—:—/mi)" />
          <Text className="text-xs text-gray-400 mt-3">
            Projections are based on your current vDot score.
          </Text>
        </Card>
      </View>
    </ScrollView>
  );
}

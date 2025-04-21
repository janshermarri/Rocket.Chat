import { Box } from '@rocket.chat/fuselage';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { useLicense, useLicenseName } from '../../hooks/useLicense';

export const SidebarFooterWatermark = (): ReactElement | null => {
	const { t } = useTranslation();

	const response = useLicense();

	const licenseName = useLicenseName();

	if (response.isLoading || response.isError) {
		return null;
	}

	if (licenseName.isError || licenseName.isLoading) {
		return null;
	}

	const license = response.data;

	if (license?.activeModules.includes('hide-watermark') && !license.trial) {
		return null;
	}

	return (
		<Box pi={16} pbe={8}>
		</Box>
	);
};

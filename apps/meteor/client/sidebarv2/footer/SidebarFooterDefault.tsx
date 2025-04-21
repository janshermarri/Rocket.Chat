import { css } from '@rocket.chat/css-in-js';
import { Palette, SidebarFooter as Footer } from '@rocket.chat/fuselage';
import { useSetting } from '@rocket.chat/ui-contexts';
import { useThemeMode } from '@rocket.chat/ui-theming';
import type { ReactElement } from 'react';


const SidebarFooterDefault = (): ReactElement => {
	const [, , theme] = useThemeMode();

	return (
		<Footer>
		</Footer>
	);
};

export default SidebarFooterDefault;

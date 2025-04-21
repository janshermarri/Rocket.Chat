import { Box } from '@rocket.chat/fuselage';
import { useAtLeastOnePermission, useSetting, useTranslation, useRole, usePermission } from '@rocket.chat/ui-contexts';
import type { ReactElement } from 'react';

import HomePageHeader from './HomePageHeader';
import AddUsersCard from './cards/AddUsersCard';
import CreateChannelsCard from './cards/CreateChannelsCard';
import CustomContentCard from './cards/CustomContentCard';
import DesktopAppsCard from './cards/DesktopAppsCard';
import DocumentationCard from './cards/DocumentationCard';
import JoinRoomsCard from './cards/JoinRoomsCard';
import MobileAppsCard from './cards/MobileAppsCard';
import Page from '../../components/Page/Page';
import PageScrollableContent from '../../components/Page/PageScrollableContent';


const DefaultHomePage = (): ReactElement => {
	return (
		<Page color='default' data-qa='page-home' data-qa-type='default' background='tint'>
			<HomePageHeader />
			<PageScrollableContent>
				<Box is='h2' fontScale='h1' mb={20} data-qa-id='homepage-welcome-text'>
					Welcome to Transmit Chat
				</Box>
			</PageScrollableContent>
		</Page>
	);
};

export default DefaultHomePage;

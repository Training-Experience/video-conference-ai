<?php

namespace IndexBundle\Controller;

use Http\Client\Common\HttpMethodsClient;
use IndexBundle\DependencyInjection\AudioTranscriber;
use IndexBundle\DependencyInjection\EmailSender;
use IndexBundle\DependencyInjection\FileManager;
use IndexBundle\Entity\User;
use IndexBundle\Entity\VideoConference\Room;
use IndexBundle\Entity\VideoConference\Transcript;
use IndexBundle\Form\Type\AutosizeTextareaType;
use IndexBundle\Form\Type\StarRatingType;
use IndexBundle\Service\AiSuggestionAPI;
use Sensio\Bundle\FrameworkExtraBundle\Configuration\Security;
use Symfony\Component\Form\Extension\Core\Type\EmailType;
use Symfony\Component\Form\Extension\Core\Type\FormType;
use Symfony\Component\Form\Extension\Core\Type\SubmitType;
use Symfony\Component\Form\FormFactory;
use Symfony\Component\HttpFoundation\File\UploadedFile;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\Session\Session;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\Process\Process;
use Symfony\Component\Routing\Annotation\Route;

class VideoConferenceController extends \Symfony\Bundle\FrameworkBundle\Controller\Controller
{
    /**
     * Join video conference
     *
     * @Route("video-conference/{roomId}", name="video_conference_room")
     *
     * @param Request $request
     * @return Response
     */
    public function roomAction($roomId, Request $request)
    {
        $em = $this->getDoctrine()->getManager();
        /** @var Room $room */
        $room = $em->getRepository(Room::class)->findOneBy(['slug' => $roomId]);

        if (!$room) {
            try {
                $room = $em->getRepository(Room::class)->find($roomId);
            } catch (\Exception $exception) {
                //Not an UUID
                throw $this->createNotFoundException();
            }
        }

        if (!$room) {
            throw $this->createNotFoundException();
        }

        if (!$room->isLive()) {
            $displayTimezone = $room->getInterview() ? $room->getInterview()->getApplication()->getInterviewTimezone() ?: 'Europe/Madrid' : 'Europe/Madrid';
            $dateFormatter = new \IntlDateFormatter($request->getLocale(), \IntlDateFormatter::FULL, \IntlDateFormatter::SHORT, $displayTimezone, \IntlDateFormatter::GREGORIAN);
            $dateFormatter->setPattern($dateFormatter->getPattern()." (zzzz)");

            $translator = $this->get('translator');
            $this->addFlash('token_error_message', $translator->trans('interviews.video_conference.room_not_live_message', [
                '%start%' => $dateFormatter->format($room->getScheduledAt()),
                '%end%' => $dateFormatter->format($room->getExpiresAt()),
            ], 'interviews'));
            return $this->render('@Index/Token/error.html.twig');
        }

        /** @var User $user */
        $user = $this->getUser();

        if (!$user) {
            if ($room->isAllowGuests()) {
                return $this->redirectToRoute('video_conference_room_guest', ['roomId' => $room->getSlug()]);
            } else {
                return $this->createNotFoundException();
            }
        }

        $this->refreshConnections($room);

        $uniqueToken = $this->getParameter('peerjs_prefix').'-'.$room->getId().'-'.$user->getId();

        $userName = null;
        if ($user->getType() == User::TYPE_COMPANY) {
            $userName = $user->getName().' - '.$user->getCompany()->getName();
        } elseif ($user->getType() == User::TYPE_TRAINEE) {
            $userName = $user->getName();
        } elseif ($user->getType() == User::TYPE_INSTITUTION) {
            $userName = $user->getName().' - '.$user->getInstitution()->getName();
        } elseif ($user->getType() == User::TYPE_ADMIN) {
            $userName = 'TX '.$user->getName();
        }

        $room->addConnection($uniqueToken, $userName, $user->getType());
        $em->flush();

        return $this->render('@Index/VideoConference/room3.html.twig', [
            'room' => $room,
            'uniqueToken' => $uniqueToken,
            'userName' => $userName,
            'turn_credentials' => $this->generateTurnCredentials()
        ]);
    }

    /**
     * Join Video conference as guest
     *
     * @Route("video-conference/{roomId}/guest", name="video_conference_room_guest")
     *
     * @param Request $request
     * @return Response
     */
    public function roomGuestAction($roomId, Request $request)
    {
        $em = $this->getDoctrine()->getManager();
        /** @var Room $room */
        $room = $em->getRepository(Room::class)->findOneBy(['slug' => $roomId]);

        if (!$room) {
            try {
                $room = $em->getRepository(Room::class)->find($roomId);
            } catch (\Exception $exception) {
                //Not an UUID
                throw $this->createNotFoundException();
            }
        }

        if (!$room) {
            throw $this->createNotFoundException();
        }

        if (!$room->isLive()) {
            $displayTimezone = $room->getInterview() ? $room->getInterview()->getApplication()->getInterviewTimezone() ?: 'Europe/Madrid' : 'Europe/Madrid';
            $dateFormatter = new \IntlDateFormatter($request->getLocale(), \IntlDateFormatter::FULL, \IntlDateFormatter::SHORT, $displayTimezone, \IntlDateFormatter::GREGORIAN);
            $dateFormatter->setPattern($dateFormatter->getPattern()." (zzzz)");

            $translator = $this->get('translator');
            $this->addFlash('token_error_message', $translator->trans('interviews.video_conference.room_not_live_message', [
                '%start%' => $dateFormatter->format($room->getScheduledAt()),
                '%end%' => $dateFormatter->format($room->getExpiresAt()),
            ], 'interviews'));
            return $this->render('@Index/Token/error.html.twig');
        }

        if (!$room->isAllowGuests()) {
            throw $this->createNotFoundException();
        }

        $this->refreshConnections($room);

        //Get user token from session or create new one
        /** @var Session $session */
        $session = $this->container->get('session');
        $videoConferenceId = $session->get('video_conference_id');

        if (!$videoConferenceId) {
            $videoConferenceId = uniqid();
            $session->set('video_conference_id', $videoConferenceId);
        }

        $uniqueToken = $this->getParameter('peerjs_prefix').'-'.$room->getId().'-'.$videoConferenceId;

        $room->addConnection($uniqueToken);
        $em->flush();

        return $this->render('@Index/VideoConference/room3.html.twig', [
            'room' => $room,
            'uniqueToken' => $uniqueToken,
            'userName' => null,
            'turn_credentials' => $this->generateTurnCredentials()
        ]);
    }

    /**
     * @Route("video-conference/{room}/connect", name="video_conference_connect_room", options = { "expose" = true })
     *
     * @param Room $room
     * @param Request $request
     * @return JsonResponse
     */
    public function connectAction(Room $room, Request $request)
    {
        $em = $this->getDoctrine()->getManager();

        if (!$room) {
            throw $this->createNotFoundException();
        }

        if (!$room->isLive()) {
            throw $this->createNotFoundException();
        }

        $user = $this->getUser();

        if (!$user and !$room->isAllowGuests()) {
            throw $this->createAccessDeniedException();
        }

        if (!$room->hasConnection($this->getUniqueToken($room))) {
            throw $this->createAccessDeniedException();
        }

        $this->refreshConnections($room);

        $room->connectConnection($this->getUniqueToken($room));
        $em->flush();

        return new JsonResponse(['success' => true, 'connections' => $room->getConnections()]);
    }

    /**
     * Evaluate video conference quality
     *
     * @Route("video-conference/{room}/evaluate", name="video_conference_evaluate_room", options = { "expose" = true })
     *
     * @param Room $room
     * @param Request $request
     * @return \Symfony\Component\HttpFoundation\RedirectResponse|Response|null
     */
    public function evaluateRoomAction(Room $room, Request $request)
    {
        $em = $this->getDoctrine()->getManager();
        /** @var Session $session */
        $session = $this->container->get('session');
        $videoConferenceId = $this->getUser() ? $this->getUser()->getId() : $session->get('video_conference_id');

        $uniqueToken = $this->getParameter('peerjs_prefix').'-'.$room->getId().'-'.$videoConferenceId;

        if (!$room->hasConnection($uniqueToken)) {
            throw $this->createNotFoundException();
        }

        $formFactory = $this->get('form.factory');
        $form = $formFactory->createBuilder(FormType::class)
            ->add('rating', StarRatingType::class, [
                'show_clear' => false,
                'required' => false
            ])
            ->add('comment', AutosizeTextareaType::class, [
                'required' => false
            ])
            ->add('skip', SubmitType::class)
            ->getForm();

        $redirectionRoute = $this->redirectToRoute('homepage');

        $form->handleRequest($request);
        if ($form->isValid()) {
            if ($form->get('skip')->isClicked()) {
                $room->disconnectConnection($uniqueToken);
                $em->flush();
                return $redirectionRoute;
            }
            $room->disconnectConnection($uniqueToken);
            $room->setConnectionEvaluation($uniqueToken, $form->getData()['rating'], $form->getData()['comment']);
            $em->flush();
            return $redirectionRoute;
        }

        return $this->render('@Index/VideoConference/evaluate.html.twig', [
            'form' => $form->createView(),
            'room' => $room
        ]);
    }

    /**
     * Set name of participant
     *
     * @Route("video-conference/{room}/set-name", name="video_conference_set_room_user_name", options = { "expose" = true })
     *
     * @param Room $room
     * @return Response
     */
    public function setRoomUserName(Room $room, Request $request)
    {
        $userName = $request->get('userName');
        if (!$userName) {
            return new JsonResponse(['success' => false, 'message' => 'User name is required'], 400);
        }

        $room->setConnectionName($this->getUniqueToken($room), $userName);
        $this->getDoctrine()->getManager()->flush();

        return new JsonResponse(['success' => true]);
    }

    /**
     * Get name of participant
     *
     * @Route("video-conference/{room}/get-connection-user-name/{connection}", name="video_conference_get_room_connection_user_name", options = { "expose" = true })
     *
     * @param Room $room
     * @param $connection
     * @return JsonResponse
     */
    public function getRoomConnectionUserName(Room $room, $connection)
    {
        if (!array_key_exists($this->getUniqueToken($room), $room->getConnections())) {
            return new JsonResponse(['success' => false, 'message' => 'You are not part of this room'], 400);
        }

        return new JsonResponse(['success' => true, 'userName' => $room->getConnectionName($connection)]);
    }

    /**
     * Get name of participant
     *
     * @Route("video-conference/{room}/get-connection-role/{connection}", name="video_conference_get_room_connection_role", options = { "expose" = true })
     *
     * @param Room $room
     * @param $connection
     * @return JsonResponse
     */
    public function getRoomConnectionRole(Room $room, $connection)
    {
        if (!array_key_exists($this->getUniqueToken($room), $room->getConnections())) {
            return new JsonResponse(['success' => false, 'message' => 'You are not part of this room'], 400);
        }

        return new JsonResponse(['success' => true, 'role' => $room->getConnectionRole($connection)]);
    }

    /**
     * Get information about connected users
     *
     * @Route("video-conference/{room}/get-connections", name="video_conference_get_room_connections", options = { "expose" = true })
     *
     * @param Room $room
     * @return JsonResponse
     */
    public function getRoomConnections(Room $room)
    {
        $this->refreshConnections($room);
        if (!array_key_exists($this->getUniqueToken($room), $room->getConnections())) {
            return new JsonResponse(['success' => false, 'message' => 'You are not part of this room'], 400);
        }

        return new JsonResponse(['success' => true, 'connections' => $room->getConnections()]);
    }

    /**
     * Invite participants to join video conference
     *
     * @Route("video-conference/{room}/invite", name="video_conference_invite", options = { "expose" = true })
     *
     * @param Room $room
     * @param Request $request
     * @return Response
     */
    public function inviteAction(Room $room, Request $request)
    {
        $uniqueToken = $this->getUniqueToken($room);
        if (!array_key_exists($uniqueToken, $room->getConnections())) {
            return new JsonResponse(['success' => false, 'message' => 'You are not part of this room'], 400);
        }

        /** @var FormFactory $formFactory */
        $formFactory = $this->get('form.factory');
        $form = $formFactory->createNamedBuilder('invite_participant', FormType::class, null, [
            'action' => $this->generateUrl('video_conference_invite', ['room' => $room->getId()]),
            'method' => 'POST',
        ])->add('email', EmailType::class, [
            'required' => true
        ])->getForm();

        $form->handleRequest($request);
        if ($form->isValid()) {
            $email = $form->get('email')->getData();
            /** @var EmailSender $emailSender */
            $emailSender = $this->get('email_sender');
            $emailSender->sendEmail(\IndexBundle\Entity\EmailType::TYPE_VIDEO_CONFERENCE_INVITE_PARTICIPANT, null, $email, [
                'room' => $room,
                'inviter_name' => $room->getConnectionName($uniqueToken)
            ]);
            return new JsonResponse([
                'success' => true,
                'message' => $this->get('translator')->trans('interviews.video_conference.invite_participant.success', [
                    '%email%' => $email
                ], 'interviews')
            ]);
        }

        return $this->render('@Index/form/invite_video_conference_participant_form.html.twig', [
            'form' => $form->createView(),
            'room' => $room
        ]);
    }

    /**
     * Disconnect user from video conference
     *
     * @Route("video-conference/{room}/disconnect", name="video_conference_disconnect_room", options = { "expose" = true })
     *
     * @param Room $room
     * @return Response
     */
    public function disconnectRoomAction(Room $room)
    {
        $room->disconnectConnection($this->getUniqueToken($room));
        $this->getDoctrine()->getManager()->flush();

        return $this->redirectToRoute('video_conference_evaluate_room', ['room' => $room->getId()]);
    }

    /**
     * @Route("video-conference/{room}/heart-beat", name="video_conference_heart_beat", options = { "expose" = true })
     *
     * @param Room $room
     * @return JsonResponse
     */
    public function heartBeatAction(Room $room)
    {
        $room->heartBeat($this->getUniqueToken($room));
        $this->getDoctrine()->getManager()->flush();
        $this->refreshConnections($room);

        return new JsonResponse(['success' => true]);
    }

    /**
     * Disconnect users that have missed a heart beat (more than 80 seconds)
     *
     * @param Room $room
     * @return void
     */
    private function refreshConnections(Room $room)
    {
        $now = new \DateTime();

        $updated = false;
        foreach ($room->getConnections() as $key => $connection) {
            if ($connection['state'] === 'connected' and (!isset($connection['lastActive']) or ($now->getTimestamp() - ($connection['lastActive'])->getTimestamp()) > 80)) {
                $room->disconnectConnection($key);
                $updated = true;
            }
        }

        if ($updated) {
            $this->getDoctrine()->getManager()->flush();
        }
    }

    /**
     * Get recommended question suggestions for interview (interviewer side)
     *
     * @Route("video-conference/{room}/get-interviewer-questions", name="video_conference_get_interviewer_questions", options = { "expose" = true })
     * @Security("has_role('ROLE_COMPANY_GUEST') or has_role('ROLE_ADMIN')")
     *
     * @param Request $request
     * @param Room $room
     * @return Response
     */
    public function getInterviewerQuestions(Request $request, Room $room)
    {
        $aiService = $this->get('ai_suggestion_api');

        if (!$room->getInterview() and !$room->getInterview()->getApplication()) {
            return new JsonResponse(['success' => false, 'message' => 'Interview not found'], 400);
        }

        if (!$this->isGranted('get_interviewer_questions', $room)) {
            return new JsonResponse(['success' => false, 'message' => 'You are not allowed to get questions'], 401);
        }

        $application = $room->getInterview()->getApplication();

        //Temporary fix for unparsed resumes
        $trainee = $application->getTrainee();

        if ($request->get('refresh', false) or empty($room->getRecommendedQuestions())) {
            $questions = $aiService->getRecommendedInterviewQuestions($application->getOffer(), $application->getTrainee(), $this->getUser(), $room, $request->getLocale());
            $room->setRecommendedQuestions($questions);
            $dbUpdated = true;
        } else {
            $questions = $room->getRecommendedQuestions();
        }

        if ($dbUpdated) {
            $this->getDoctrine()->getManager()->flush();
        }

        if (isset($questions) and !empty($questions)) {
            return new JsonResponse(['success' => true, 'questions' => $questions]);
        } else {
            return new JsonResponse(['success' => false, 'message' => 'Questions not found'], 503);
        }

    }

    /**
     * @Route("video-conference/{room}/upload-audio", name="video_conference_upload_room_audio", options = { "expose" = true })
     *
     * @param Request $request
     * @param Room $room
     * @return JsonResponse
     */
    public function uploadRoomAudioAction(Request $request, Room $room)
    {
        if (!$this->isGranted('transcribe_audio', $room)) {
            return new JsonResponse(['success' => false, 'message' => 'You are not allowed to upload audio'], 401);
        }

        /** @var UploadedFile $file */
        $file = $request->files->get('audio');
        $startTimeStamp = $request->get('startTimestamp');
        $endTimeStamp = $request->get('endTimestamp');
        $emotions = $request->get('emotions', null);
        if ($emotions) {
            $emotions = json_decode($emotions);
        }
        $filePath = null;
        if (!$file) {
            return new JsonResponse(['success' => false, 'message' => 'File not found'], 400);
        }

        try {

            $fileName = md5(uniqid()).'.'.$file->guessExtension();
            $file->move(sys_get_temp_dir(), $fileName);
            $filePath = sys_get_temp_dir().'/'.$fileName;

            // Perform transcription
            /** @var AudioTranscriber $audioTranscriber */
            $audioTranscriber = $this->get('audio_transcriber');
            // Sends audio file to an external service for transcription
            $transcription = $audioTranscriber->transcribe($filePath);

            // Delete the temporary file
            unlink($filePath);

            if (!$transcription) {
                return new JsonResponse(['success' => false, 'message' => 'Transcription failed'], 400);
            }

            $transcript = new Transcript();
            $transcript->setRoom($room);
            $transcript->setTranscript($transcription);
            $transcript->setStartTimeStamp($startTimeStamp);
            $transcript->setEndTimeStamp($endTimeStamp);
            $transcript->setConnection($this->getUniqueToken($room));
            if ($emotions and is_array($emotions) and !empty($emotions)) {
                $transcript->setEmotions($emotions);
            }
            $room->addTranscript($transcript);
            $this->getDoctrine()->getManager()->persist($transcript);
            $this->getDoctrine()->getManager()->flush();

            return new JsonResponse(['success' => true, 'transcription' => $transcription]);
        } catch (Exception $e) {
            if ($filePath) {
                unlink($filePath);
            }
            $this->get('logger')->critical('Error while transcribing video conference audio: ' . $e->getMessage(), [$e->getTraceAsString()]);
            return new JsonResponse(['success' => false], 400);
        }
    }

    /**
     * @Route("video-conference/{room}/generate-interview-analysis", name="video_conference_generate_interview_analysis", options = { "expose" = true })
     *
     * @param Request $request
     * @param Room $room
     * @return JsonResponse
     */
    public function generateInterviewAnalysisAction(Request $request, Room $room)
    {
        if (!$room) {
            return new JsonResponse(['success' => false, 'message' => 'Room not found'], 404);
        }

        if (!$this->isGranted('generate_ai_report', $room)) {
            return new JsonResponse(['success' => false, 'message' => 'You are not allowed to generate AI report'], 401);
        }

        /** @var AiSuggestionAPI $aiSuggestionAPI */
        $aiSuggestionAPI = $this->get('ai_suggestion_api');
        $result = $aiSuggestionAPI->generateInterviewAnalysisReport($room, $request->getLocale());
        $room->setAiAnalysis($result);
        $this->getDoctrine()->getManager()->flush();
        return new JsonResponse(['success' => true, 'result' => $result]);
    }

    /**
     * Get unique user ID for the video conference room
     *
     * @param Room $room
     * @return string|null
     */
    private function getUniqueToken(Room $room)
    {
        $user = $this->getUser();
        if ($user) {
            return $this->getParameter('peerjs_prefix').'-'.$room->getId().'-'.$user->getId();
        } else {
            $session = $this->get('session');
            if ($session->has('video_conference_id')) {
                return $this->getParameter('peerjs_prefix').'-'.$room->getId().'-'.$session->get('video_conference_id');
            } else {
                return null;
            }
        }
    }
}